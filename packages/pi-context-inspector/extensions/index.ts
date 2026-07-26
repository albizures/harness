import type {
  BuildSystemPromptOptions,
  ContextUsage,
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const COMMAND_NAME = "context-inspector";
const COMMAND_DESCRIPTION = "Inspect estimated Pi context usage by source.";
const APPROX_CHARS_PER_TOKEN = 4;
const MAX_CONTRIBUTORS_PER_BUCKET = 5;
const MATERIAL_BUCKET_TOKEN_THRESHOLD = 1000;
const OVERLAY_SCROLL_STEP_LINES = 1;
const OVERLAY_PAGE_STEP_LINES = 10;
const OVERLAY_BODY_VIEWPORT_LINES = 24;

type ContextInspectorModel = {
  id: string;
  provider: string;
  contextWindow: number;
};

export type ContextInspectorInputs = {
  collectedAt: Date;
  idle: boolean;
  model?: ContextInspectorModel;
  contextUsage?: ContextUsage;
  systemPrompt: string;
  systemPromptOptions: BuildSystemPromptOptions;
  entries: unknown[];
};

export type ContextContributor = {
  name: string;
  estimatedTokens: number;
};

export type ContextBucket = {
  name: string;
  estimatedTokens: number;
  sharePercent: number;
  contributors: ContextContributor[];
};

export type ContextAttributionEstimate = {
  estimatedTotalTokens: number;
  buckets: ContextBucket[];
};

export default function (pi: ExtensionAPI) {
  pi.registerCommand(COMMAND_NAME, {
    description: COMMAND_DESCRIPTION,
    handler: async (_args, ctx) => {
      const inputs = collectContextInspectorInputs(ctx);
      const attribution = estimateContextAttribution(inputs);
      const report = {
        plain: renderContextInspectorReport(inputs, attribution),
        renderTui: (colorValue: (value: string) => string) => renderTuiContextInspectorReport(inputs, attribution, colorValue),
      };
      await showContextInspectorReport(ctx, report);
    },
  });
}

export function collectContextInspectorInputs(ctx: ExtensionCommandContext): ContextInspectorInputs {
  const contextUsage = ctx.getContextUsage();
  const model = ctx.model
    ? {
        id: ctx.model.id,
        provider: ctx.model.provider,
        contextWindow: ctx.model.contextWindow,
      }
    : undefined;

  return {
    collectedAt: new Date(),
    idle: ctx.isIdle(),
    model,
    contextUsage,
    systemPrompt: ctx.getSystemPrompt(),
    systemPromptOptions: ctx.getSystemPromptOptions(),
    entries: ctx.sessionManager.buildContextEntries(),
  };
}

export function estimateContextAttribution(inputs: ContextInspectorInputs): ContextAttributionEstimate {
  const rawBuckets = [
    estimateSystemPromptBucket(inputs),
    estimateToolDefinitionsBucket(inputs.systemPromptOptions),
    estimateContextFilesBucket(inputs.systemPromptOptions),
    estimateSkillsBucket(inputs.systemPromptOptions),
    ...estimateMessageBuckets(inputs.entries),
  ].filter((bucket) => bucket.estimatedTokens > 0);
  const rawTotal = rawBuckets.reduce((total, bucket) => total + bucket.estimatedTokens, 0);
  const authoritativeTotal = knownTotalTokens(inputs.contextUsage);
  const denominator = authoritativeTotal ?? rawTotal;
  const buckets = (authoritativeTotal === undefined || rawTotal === 0
    ? rawBuckets
    : scaleBuckets(rawBuckets, authoritativeTotal, rawTotal)
  )
    .filter((bucket) => bucket.estimatedTokens > 0)
    .map((bucket) => ({
      ...bucket,
      sharePercent: denominator > 0 ? (bucket.estimatedTokens / denominator) * 100 : 0,
    }))
    .sort((a, b) => b.estimatedTokens - a.estimatedTokens);

  return {
    estimatedTotalTokens: buckets.reduce((total, bucket) => total + bucket.estimatedTokens, 0),
    buckets,
  };
}

export function renderContextInspectorReport(
  inputs: ContextInspectorInputs,
  attribution: ContextAttributionEstimate,
): string {
  return renderContextInspectorReportWithValueFormatter(inputs, attribution, (value) => value);
}

export function renderTuiContextInspectorReport(
  inputs: ContextInspectorInputs,
  attribution: ContextAttributionEstimate,
  colorValue: (value: string) => string,
): string {
  return renderContextInspectorReportWithValueFormatter(inputs, attribution, colorValue);
}

type ContextInspectorReport = {
  plain: string;
  renderTui: (colorValue: (value: string) => string) => string;
};

function renderContextInspectorReportWithValueFormatter(
  inputs: ContextInspectorInputs,
  attribution: ContextAttributionEstimate,
  formatValue: (value: string) => string,
): string {
  const model = inputs.model
    ? `${inputs.model.provider}/${inputs.model.id}`
    : "unknown";
  const contextWindow = inputs.contextUsage?.contextWindow ?? inputs.model?.contextWindow;
  const usage = renderKnownUsage(inputs.contextUsage);
  const activeState = inputs.idle ? "idle" : "active";
  const contextWindowValue = contextWindow === undefined ? "unknown" : `${formatTokens(contextWindow)} tokens`;

  const lines = [
    "# Context Inspector",
    "",
    "Point-in-time active context snapshot. Pi may keep streaming, running tools, or enqueueing follow-up work after this report is collected.",
    "",
    `Collected: ${formatValue(`${inputs.collectedAt.toISOString()} (${activeState} at collection time)`)}`,
    `Model: ${formatValue(model)}`,
    `Context window: ${formatValue(contextWindowValue)}`,
    `Pi authoritative total: ${formatValue(usage.total)}`,
    `Percentage: ${formatValue(usage.percent)}`,
    "",
    "Pi's total usage above is the authoritative active-context number available from Pi. Source attribution below is estimated from prompt inputs and active session entries; it is not provider-exact token accounting.",
    ...(knownTotalTokens(inputs.contextUsage) === undefined
      ? ["Pi total is unknown; source shares use the unscaled visible-source estimate as their denominator."]
      : []),
    "Tool definitions are estimated from prompt-visible names and snippets, not provider-serialized schemas.",
    "",
    "## Estimated source attribution",
    `Estimated sum of visible sources: ${formatValue(`${formatTokens(attribution.estimatedTotalTokens)} tokens`)}`,
    "",
  ];

  if (attribution.buckets.length === 0) {
    lines.push("No source inputs were available to estimate.");
  } else {
    for (const bucket of attribution.buckets) {
      lines.push(`- ${bucket.name}: ${formatValue(`~${formatTokens(bucket.estimatedTokens)} tokens`)} ${formatValue(`(${bucket.sharePercent.toFixed(1)}%)`)}`);
      if (isMaterialBucket(bucket)) {
        for (const contributor of bucket.contributors.slice(0, MAX_CONTRIBUTORS_PER_BUCKET)) {
          lines.push(`  - ${contributor.name}: ${formatValue(`~${formatTokens(contributor.estimatedTokens)} tokens`)}`);
        }
      }
    }
  }

  const recommendations = renderReadOnlyRecommendations(attribution);
  if (recommendations.length > 0) {
    lines.push("", "## Read-only recommendations", ...recommendations.map((text) => `- ${text}`));
  }

  lines.push(
    "",
    "Read-only report: contributor names and estimates are shown without raw content snippets.",
  );

  return lines.join("\n");
}

export async function showContextInspectorReport(ctx: ExtensionCommandContext, report: string | ContextInspectorReport): Promise<void> {
  if (ctx.mode === "tui" && ctx.hasUI) {
    try {
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          const displayReport = typeof report === "string"
            ? report
            : report.renderTui((value) => theme.fg("accent", value));
          let scrollOffset = 0;
          let cachedBodyWidth: number | undefined;
          let cachedBodyLines: string[] | undefined;

          const bodyLines = (innerWidth: number): string[] => {
            const bodyWidth = Math.max(1, innerWidth);
            if (cachedBodyLines && cachedBodyWidth === bodyWidth) return cachedBodyLines;
            cachedBodyWidth = bodyWidth;
            cachedBodyLines = displayReport
              .split("\n")
              .flatMap((line) => wrapTextWithAnsi(line, bodyWidth))
              .map((line) => truncateToWidth(line, bodyWidth, ""));
            scrollOffset = clampScrollOffset(scrollOffset, cachedBodyLines.length, OVERLAY_BODY_VIEWPORT_LINES);
            return cachedBodyLines;
          };

          const scrollBy = (delta: number): void => {
            scrollOffset = clampScrollOffset(
              scrollOffset + delta,
              scrollableLineCount(displayReport, cachedBodyLines),
              OVERLAY_BODY_VIEWPORT_LINES,
            );
          };

          return {
            render(width: number): string[] {
              const innerWidth = framedContentWidth(width);
              const title = theme.fg("accent", theme.bold("Context Inspector"));
              const lines = bodyLines(innerWidth);
              const position = visibleRange(scrollOffset, lines.length, OVERLAY_BODY_VIEWPORT_LINES);
              const help = theme.fg("dim", `esc/enter closes • ↑↓ scroll • pgup/pgdn jump • read-only • ${position}`);
              return [
                frameBorderLine(width, "top", (text) => theme.fg("accent", text)),
                frameContentLine(title, width, (text) => theme.fg("accent", text)),
                frameContentLine(help, width, (text) => theme.fg("accent", text)),
                frameContentLine("", width, (text) => theme.fg("accent", text)),
                ...lines
                  .slice(scrollOffset, scrollOffset + OVERLAY_BODY_VIEWPORT_LINES)
                  .map((line) => frameContentLine(line, width, (text) => theme.fg("accent", text))),
                frameBorderLine(width, "bottom", (text) => theme.fg("accent", text)),
              ];
            },
            handleInput(data: string): void {
              if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("c"))) {
                done(undefined);
                return;
              }

              if (matchesKey(data, Key.down)) {
                scrollBy(OVERLAY_SCROLL_STEP_LINES);
              } else if (matchesKey(data, Key.up)) {
                scrollBy(-OVERLAY_SCROLL_STEP_LINES);
              } else if (matchesKey(data, Key.pageDown)) {
                scrollBy(OVERLAY_PAGE_STEP_LINES);
              } else if (matchesKey(data, Key.pageUp)) {
                scrollBy(-OVERLAY_PAGE_STEP_LINES);
              } else if (matchesKey(data, Key.home)) {
                scrollOffset = 0;
              } else if (matchesKey(data, Key.end)) {
                scrollOffset = clampScrollOffset(
                  Number.MAX_SAFE_INTEGER,
                  scrollableLineCount(displayReport, cachedBodyLines),
                  OVERLAY_BODY_VIEWPORT_LINES,
                );
              }
              tui.requestRender();
            },
            invalidate() {
              cachedBodyWidth = undefined;
              cachedBodyLines = undefined;
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "90%",
            minWidth: 40,
            maxHeight: "80%",
            margin: 1,
          },
        },
      );
      return;
    } catch {
      // Some UI backends report hasUI but cannot host full TUI components.
      // Fall through to the compact notification fallback when possible.
    }
  }

  if (ctx.hasUI) {
    ctx.ui.notify("Context Inspector: report ready (open in TUI mode for the scrollable view).", "info");
    return;
  }

  // Print/json modes have no UI surface. Keep the helper side-effect free there.
}

function scrollableLineCount(report: string, renderedLines: string[] | undefined): number {
  return renderedLines?.length ?? report.split("\n").length;
}

function clampScrollOffset(offset: number, lineCount: number, viewportLines: number): number {
  return Math.max(0, Math.min(offset, Math.max(0, lineCount - viewportLines)));
}

function visibleRange(scrollOffset: number, lineCount: number, viewportLines: number): string {
  if (lineCount === 0) return "0/0";
  const start = Math.min(scrollOffset + 1, lineCount);
  const end = Math.min(scrollOffset + viewportLines, lineCount);
  return `${start}-${end}/${lineCount}`;
}

function framedContentWidth(width: number): number {
  return Math.max(1, width - 4);
}

function frameBorderLine(width: number, edge: "top" | "bottom", color: (text: string) => string): string {
  const left = edge === "top" ? "┌" : "└";
  const right = edge === "top" ? "┐" : "┘";
  return truncateToWidth(color(left + "─".repeat(Math.max(0, width - 2)) + right), width, "");
}

function frameContentLine(content: string, width: number, color: (text: string) => string): string {
  const innerWidth = framedContentWidth(width);
  const truncated = truncateToWidth(content, innerWidth, "");
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
  return truncateToWidth(`${color("│")} ${truncated}${padding} ${color("│")}`, width, "");
}

function estimateSystemPromptBucket(inputs: ContextInspectorInputs): ContextBucket {
  const options = inputs.systemPromptOptions;
  const explicitPromptInputs = [
    options.appendSystemPrompt,
    options.customPrompt,
    options.promptGuidelines?.join("\n"),
    ...(options.contextFiles ?? []).map((file) => file.content),
    ...(options.skills ?? []).map((skill) => {
      const record = skill as unknown as Record<string, unknown>;
      return [record.description, record.content, record.body]
        .filter((value): value is string => typeof value === "string")
        .join("\n");
    }),
    ...promptVisibleToolSnippets(options).map(([, snippet]) => snippet),
  ];
  const residualSystemTokens = Math.max(
    0,
    estimateTokens(inputs.systemPrompt) - explicitPromptInputs.reduce((total, text) => total + (text ? estimateTokens(text) : 0), 0),
  );

  const contributors = [
    { name: "Base Pi system prompt text", estimatedTokens: residualSystemTokens },
    contributor("Appended system prompt", options.appendSystemPrompt),
    contributor("Custom system prompt", options.customPrompt),
    contributor("Prompt guidelines", options.promptGuidelines?.join("\n")),
  ].filter(isContributor);

  return bucket("System prompt", contributors);
}

function estimateToolDefinitionsBucket(options: BuildSystemPromptOptions): ContextBucket {
  const snippets = options.toolSnippets ?? {};
  const activeTools = activeToolNames(options);
  const contributors = promptVisibleToolSnippets(options).map(([name, snippet]) => contributor(name, snippet));
  for (const toolName of activeTools) {
    if (!snippets[toolName]) contributors.push({ name: safeContributorName(toolName), estimatedTokens: estimateTokens(toolName) });
  }
  return bucket("Tool definitions", contributors.filter(isContributor));
}

function activeToolNames(options: BuildSystemPromptOptions): string[] {
  return options.selectedTools ?? ["read", "bash", "edit", "write"];
}

function promptVisibleToolSnippets(options: BuildSystemPromptOptions): Array<[string, string]> {
  const snippets = options.toolSnippets ?? {};
  return activeToolNames(options)
    .filter((name) => !!snippets[name])
    .map((name) => [name, snippets[name]]);
}

function estimateContextFilesBucket(options: BuildSystemPromptOptions): ContextBucket {
  return bucket(
    "Context files",
    (options.contextFiles ?? []).map((file) => contributor(file.path, file.content)).filter(isContributor),
  );
}

function estimateSkillsBucket(options: BuildSystemPromptOptions): ContextBucket {
  return bucket(
    "Skills",
    (options.skills ?? []).map((skill) => {
      const record = skill as unknown as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : "unnamed skill";
      const text = [record.description, record.content, record.body]
        .filter((value): value is string => typeof value === "string")
        .join("\n");
      return contributor(name, text || name);
    }).filter(isContributor),
  );
}

function estimateMessageBuckets(entries: unknown[]): ContextBucket[] {
  const grouped = new Map<string, ContextContributor[]>();

  for (const entry of entries) {
    const record = entry as Record<string, any>;
    if (record.type === "branch_summary" || record.type === "compaction") {
      addGrouped(grouped, "Compactions and summaries", contributor(record.type, extractSummaryText(record)));
      for (const retainedMessage of Array.isArray(record.retainedTail) ? record.retainedTail : []) {
        estimateAgentMessage(grouped, retainedMessage);
      }
      continue;
    }

    if (record.type === "custom_message") {
      addGrouped(
        grouped,
        "Other active entries",
        contributor(safeCustomMessageLabel(record.customType), extractContentText(record.content)),
      );
      continue;
    }

    if (record.type !== "message" || !record.message) continue;
    estimateAgentMessage(grouped, record.message);
  }

  return Array.from(grouped.entries()).map(([name, contributors]) => bucket(name, contributors.filter(isContributor)));
}

function estimateAgentMessage(grouped: Map<string, ContextContributor[]>, value: unknown): void {
  if (!value || typeof value !== "object") return;
  const message = value as Record<string, any>;
  if (message.role === "user") {
    addGrouped(grouped, "User messages", contributor("user message", extractContentText(message.content)));
  } else if (message.role === "assistant") {
    addGrouped(grouped, "Assistant messages", contributor("assistant message", extractContentText(message.content)));
  } else if (message.role === "toolResult") {
    addGrouped(grouped, "Tool results", contributor(toolResultLabel(message.toolName), extractContentText(message.content)));
  } else if (message.role === "custom") {
    addGrouped(
      grouped,
      "Other active entries",
      contributor(safeCustomMessageLabel(message.customType), extractContentText(message.content)),
    );
  } else if (message.role === "branchSummary" || message.role === "compactionSummary") {
    addGrouped(grouped, "Compactions and summaries", contributor(message.role, extractSummaryText(message)));
  }
}

function addGrouped(grouped: Map<string, ContextContributor[]>, name: string, value: ContextContributor | undefined): void {
  if (!value) return;
  const values = grouped.get(name) ?? [];
  values.push(value);
  grouped.set(name, values);
}

function bucket(name: string, contributors: ContextContributor[]): ContextBucket {
  const sortedContributors = [...contributors].sort((a, b) => b.estimatedTokens - a.estimatedTokens);
  return {
    name,
    estimatedTokens: sortedContributors.reduce((total, item) => total + item.estimatedTokens, 0),
    sharePercent: 0,
    contributors: sortedContributors,
  };
}

function isMaterialBucket(bucket: ContextBucket): boolean {
  return bucket.estimatedTokens >= MATERIAL_BUCKET_TOKEN_THRESHOLD;
}

function renderReadOnlyRecommendations(attribution: ContextAttributionEstimate): string[] {
  const buckets = new Map(attribution.buckets.map((bucket) => [bucket.name, bucket]));
  const recommendations: string[] = [];

  if (isMaterialBucketName(buckets, "Tool results")) {
    recommendations.push("Large tool results: review whether bulky outputs still need to remain in active context; a short human summary may be easier to carry forward.");
  }
  if (isMaterialBucketName(buckets, "Context files")) {
    recommendations.push("Large context files: consider whether the current project context can be narrowed to the files most relevant to this task.");
  }
  if (isMaterialBucketName(buckets, "Skills")) {
    recommendations.push("Large skills: consider whether every loaded skill is relevant to the current task before continuing.");
  }

  return recommendations;
}

function isMaterialBucketName(buckets: Map<string, ContextBucket>, name: string): boolean {
  const bucket = buckets.get(name);
  return bucket !== undefined && isMaterialBucket(bucket);
}

function knownTotalTokens(usage: ContextUsage | undefined): number | undefined {
  return usage && usage.tokens !== null ? usage.tokens : undefined;
}

function scaleBuckets(buckets: ContextBucket[], authoritativeTotal: number, rawTotal: number): ContextBucket[] {
  const scaledBuckets = scaleTokenValues(
    buckets.map((bucket) => ({ name: bucket.name, tokens: bucket.estimatedTokens })),
    authoritativeTotal,
    rawTotal,
  );
  return buckets.map((bucket, index) => {
    const estimatedTokens = scaledBuckets[index]?.tokens ?? 0;
    const contributors = scaleTokenValues(
      bucket.contributors.map((item) => ({ name: item.name, tokens: item.estimatedTokens })),
      estimatedTokens,
      bucket.estimatedTokens,
    ).map((item) => ({ name: item.name, estimatedTokens: item.tokens }));
    return { ...bucket, estimatedTokens, contributors };
  });
}

function scaleTokenValues<T extends { tokens: number }>(items: T[], targetTotal: number, rawTotal: number): T[] {
  if (rawTotal <= 0) return items.map((item) => ({ ...item, tokens: 0 }));
  const scaled = items.map((item, index) => {
    const exact = (item.tokens / rawTotal) * targetTotal;
    const tokens = Math.floor(exact);
    return { item, index, exact, tokens, remainder: exact - tokens };
  });
  let remaining = targetTotal - scaled.reduce((total, item) => total + item.tokens, 0);
  for (const item of [...scaled].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (remaining <= 0) break;
    item.tokens += 1;
    remaining -= 1;
  }
  return scaled.map(({ item, tokens }) => ({ ...item, tokens }));
}

function contributor(name: string, content: string | undefined): ContextContributor | undefined {
  if (!content) return undefined;
  return { name: safeContributorName(name), estimatedTokens: estimateTokens(content) };
}

function isContributor(value: ContextContributor | undefined): value is ContextContributor {
  return !!value && value.estimatedTokens > 0;
}

function safeContributorName(name: string): string {
  const firstLine = name.split(/[\r\n\t]/, 1)[0] ?? "";
  const normalized = firstLine.replace(/\s{2,}/g, " ").trim();
  return normalized.length > 0 ? normalized : "unnamed contributor";
}

function safeCustomMessageLabel(customType: unknown): string {
  return typeof customType === "string" ? customType : "custom message";
}

function toolResultLabel(toolName: unknown): string {
  return typeof toolName === "string" ? toolName : "tool result";
}

function extractSummaryText(entry: Record<string, any>): string {
  return typeof entry.summary === "string" ? entry.summary : "";
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function renderKnownUsage(usage: ContextUsage | undefined): { total: string; percent: string } {
  if (!usage || usage.tokens === null || usage.percent === null) {
    return { total: "unknown", percent: "unknown" };
  }
  return {
    total: `${formatTokens(usage.tokens)} tokens (${usage.percent.toFixed(1)}%)`,
    percent: `${usage.percent.toFixed(1)}%`,
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / APPROX_CHARS_PER_TOKEN));
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}
