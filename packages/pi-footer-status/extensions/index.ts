import type {
	ContextUsage,
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";

const BAR_WIDTH = 20;
const WARNING_PERCENT = 70;
const ERROR_PERCENT = 90;

type ThemeColor = "accent" | "dim" | "error" | "warning";

type FooterTheme = {
	fg(color: ThemeColor | string, text: string): string;
	bold(text: string): string;
};

type FooterModel = {
	id: string;
	provider: string;
	contextWindow: number;
	reasoning?: boolean;
};

type FooterState = {
	cwd: string;
	sessionName?: string;
	gitBranch: string | null;
	extensionStatuses: ReadonlyMap<string, string>;
	availableProviderCount: number;
	model?: FooterModel;
	thinkingLevel?: string;
	contextUsage?: ContextUsage;
	entries: ExtensionContext["sessionManager"] extends {
		getEntries(): infer Entries;
	}
		? Entries
		: never;
	usingSubscription?: boolean;
	experimental?: boolean;
	home?: string;
	autoCompactEnabled?: boolean;
};

type FooterUsage = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
};

type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

export default function (pi: ExtensionAPI) {
	let requestRender: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const disposeBranch = footerData.onBranchChange(() =>
				tui.requestRender(),
			);

			return {
				dispose() {
					disposeBranch();
					requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					return renderFooter(
						collectFooterState(
							ctx,
							footerData,
							process.env.HOME || process.env.USERPROFILE,
						),
						theme,
						width,
					);
				},
			};
		});
	});

	const rerender = () => {
		requestRender?.();
	};
	pi.on("model_select", rerender);
	pi.on("thinking_level_select", rerender);
	pi.on("session_info_changed", rerender);
	pi.on("message_end", rerender);
	pi.on("agent_settled", rerender);
	pi.on("session_compact", rerender);
}

function collectFooterState(
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	home: string | undefined,
): FooterState {
	const model = ctx.model
		? {
				id: ctx.model.id,
				provider: ctx.model.provider,
				contextWindow: ctx.model.contextWindow,
				reasoning: ctx.model.reasoning,
			}
		: undefined;

	return {
		cwd: ctx.sessionManager.getCwd(),
		sessionName: ctx.sessionManager.getSessionName(),
		gitBranch: footerData.getGitBranch(),
		extensionStatuses: footerData.getExtensionStatuses(),
		availableProviderCount: footerData.getAvailableProviderCount(),
		model,
		thinkingLevel: ctx.thinkingLevel,
		contextUsage: ctx.getContextUsage(),
		entries: ctx.sessionManager.getEntries(),
		usingSubscription: ctx.model
			? ctx.model.provider === "kimi-coding" ||
				ctx.modelRegistry.isUsingOAuth(ctx.model)
			: false,
		experimental: process.env.PI_EXPERIMENTAL === "1",
		home,
	};
}

export function renderFooter(
	state: FooterState,
	theme: FooterTheme,
	width: number,
): string[] {
	const usage = getUsageStats(state.entries);
	const contextUsage = state.contextUsage;
	const contextWindow =
		contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
	const contextPercentValue = contextUsage?.percent ?? 0;
	const contextPercent =
		contextUsage?.percent !== null && contextUsage?.percent !== undefined
			? contextPercentValue.toFixed(1)
			: "?";

	let pwd = formatCwdForFooter(state.cwd, state.home);
	if (state.gitBranch) pwd = `${pwd} (${state.gitBranch})`;
	if (state.sessionName) pwd = `${pwd} • ${state.sessionName}`;

	const statsParts: string[] = [];
	if (usage.totals.input)
		statsParts.push(`↑${formatTokens(usage.totals.input)}`);
	if (usage.totals.output)
		statsParts.push(`↓${formatTokens(usage.totals.output)}`);
	if (usage.totals.cacheRead)
		statsParts.push(`R${formatTokens(usage.totals.cacheRead)}`);
	if (usage.totals.cacheWrite)
		statsParts.push(`W${formatTokens(usage.totals.cacheWrite)}`);
	if (
		(usage.totals.cacheRead > 0 || usage.totals.cacheWrite > 0) &&
		usage.latestCacheHitRate !== undefined
	) {
		statsParts.push(`CH${usage.latestCacheHitRate.toFixed(1)}%`);
	}
	if (usage.totals.cost || state.usingSubscription) {
		statsParts.push(
			`$${usage.totals.cost.toFixed(3)}${state.usingSubscription ? " (sub)" : ""}`,
		);
	}

	const autoIndicator = state.autoCompactEnabled === false ? "" : " (auto)";
	const contextPercentDisplay =
		contextPercent === "?"
			? `?/${formatTokens(contextWindow)}${autoIndicator}`
			: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
	statsParts.push(
		colorByContextSeverity(contextPercentValue, contextPercentDisplay, theme),
	);
	if (state.experimental)
		statsParts.push(
			`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`,
		);

	const statsLine = renderStatsLine(statsParts.join(" "), state, theme, width);
	const contextBarLine = renderContextFillBar(
		{ percent: contextUsage?.percent, contextWindow },
		theme,
		width,
	);

	const lines = [
		truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
		statsLine,
		contextBarLine,
	];

	const statuses = renderExtensionStatuses(
		state.extensionStatuses,
		theme,
		width,
	);
	if (statuses) lines.push(statuses);
	return lines;
}

function renderStatsLine(
	statsLeftInput: string,
	state: FooterState,
	theme: FooterTheme,
	width: number,
): string {
	let statsLeft = statsLeftInput;
	let statsLeftWidth = visibleWidth(statsLeft);
	if (statsLeftWidth > width) {
		statsLeft = truncateToWidth(statsLeft, width, "...");
		statsLeftWidth = visibleWidth(statsLeft);
	}

	const modelName = state.model?.id || "no-model";
	let rightSideWithoutProvider = modelName;
	if (state.model?.reasoning) {
		const thinkingLevel = state.thinkingLevel || "off";
		rightSideWithoutProvider =
			thinkingLevel === "off"
				? `${modelName} • thinking off`
				: `${modelName} • ${thinkingLevel}`;
	}

	let rightSide = rightSideWithoutProvider;
	if (state.availableProviderCount > 1 && state.model) {
		rightSide = `(${state.model.provider}) ${rightSideWithoutProvider}`;
		if (statsLeftWidth + 2 + visibleWidth(rightSide) > width)
			rightSide = rightSideWithoutProvider;
	}

	const rightSideWidth = visibleWidth(rightSide);
	let statsLine: string;
	if (statsLeftWidth + 2 + rightSideWidth <= width) {
		statsLine =
			statsLeft +
			" ".repeat(width - statsLeftWidth - rightSideWidth) +
			rightSide;
	} else {
		const availableForRight = width - statsLeftWidth - 2;
		if (availableForRight > 0) {
			const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
			statsLine =
				statsLeft +
				" ".repeat(
					Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)),
				) +
				truncatedRight;
		} else {
			statsLine = statsLeft;
		}
	}

	return (
		theme.fg("dim", statsLeft) +
		theme.fg("dim", statsLine.slice(statsLeft.length))
	);
}

export function renderContextFillBar(
	usage: { percent: number | null | undefined; contextWindow: number },
	theme: FooterTheme,
	width: number,
): string {
	if (usage.percent === null || usage.percent === undefined) {
		const placeholder = theme.fg("dim", "░".repeat(BAR_WIDTH));
		return truncateToWidth(
			`context ${placeholder} ?/${formatTokens(usage.contextWindow)}`,
			width,
			theme.fg("dim", "..."),
		);
	}

	const clampedPercent = Math.max(0, Math.min(100, usage.percent));
	let filled = Math.round((clampedPercent / 100) * BAR_WIDTH);
	if (clampedPercent > 0) filled = Math.max(1, filled);
	if (clampedPercent >= 99.5) filled = BAR_WIDTH;

	const filledCells = "█".repeat(filled);
	const emptyCells = "░".repeat(BAR_WIDTH - filled);
	const severityColor =
		clampedPercent > ERROR_PERCENT
			? "error"
			: clampedPercent > WARNING_PERCENT
				? "warning"
				: "accent";
	const numeric = `${usage.percent.toFixed(1)}%/${formatTokens(usage.contextWindow)}`;
	const line = `context ${theme.fg(severityColor, filledCells)}${theme.fg("dim", emptyCells)} ${theme.fg(severityColor, numeric)}`;
	return truncateToWidth(line, width, theme.fg("dim", "..."));
}

function renderExtensionStatuses(
	statuses: ReadonlyMap<string, string>,
	theme: FooterTheme,
	width: number,
): string | undefined {
	if (statuses.size === 0) return undefined;
	const statusLine = Array.from(statuses.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text))
		.join(" ");
	return truncateToWidth(statusLine, width, theme.fg("dim", "..."));
}

function getUsageStats(entries: FooterState["entries"]): {
	totals: UsageTotals;
	latestCacheHitRate?: number;
} {
	const totals: UsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
	let latestCacheHitRate: number | undefined;

	for (const entry of entries) {
		const usage = getEntryUsage(entry);
		if (!usage) continue;
		addUsage(totals, usage);

		if (entry.type === "message" && entry.message.role === "assistant") {
			const cacheRead = usage.cacheRead ?? 0;
			const promptTokens =
				(usage.input ?? 0) + cacheRead + (usage.cacheWrite ?? 0);
			latestCacheHitRate =
				promptTokens > 0 ? (cacheRead / promptTokens) * 100 : undefined;
		}
	}

	return { totals, latestCacheHitRate };
}

function getEntryUsage(
	entry: FooterState["entries"][number],
): FooterUsage | undefined {
	if (entry.type === "message") {
		if (entry.message.role === "assistant") return entry.message.usage;
		if (entry.message.role === "toolResult") return entry.message.usage;
	}
	if (
		(entry.type === "branch_summary" || entry.type === "compaction") &&
		entry.usage
	)
		return entry.usage;
	return undefined;
}

function addUsage(totals: UsageTotals, usage: FooterUsage): void {
	totals.input += usage.input ?? 0;
	totals.output += usage.output ?? 0;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;
	totals.cost += usage.cost?.total ?? 0;
}

function colorByContextSeverity(
	percent: number,
	text: string,
	theme: FooterTheme,
): string {
	if (percent > ERROR_PERCENT) return theme.fg("error", text);
	if (percent > WARNING_PERCENT) return theme.fg("warning", text);
	return text;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(
	cwd: string,
	home: string | undefined,
): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." &&
			!relativeToHome.startsWith(`..${sep}`) &&
			!isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}
