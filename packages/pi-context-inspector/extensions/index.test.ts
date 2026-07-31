// biome-ignore-all lint/style/noMagicNumbers: Test literals describe expected token estimates and layouts.
// biome-ignore-all lint/suspicious/noExplicitAny: Tests use partial extension API fixtures.
// biome-ignore-all lint/style/noNonNullAssertion: Tests assert fixtures contain these buckets.
import assert from "node:assert/strict";
import test from "node:test";
import extension, {
	collectContextInspectorInputs,
	estimateContextAttribution,
	renderContextInspectorReport,
	renderTuiContextInspectorReport,
	showContextInspectorReport,
} from "./index.ts";

function makeCommandContext(overrides: Record<string, unknown> = {}) {
	return {
		mode: "print",
		hasUI: false,
		model: { id: "gpt-test", provider: "openai", contextWindow: 128000 },
		isIdle: () => false,
		getContextUsage: () => ({
			tokens: 51200,
			contextWindow: 128000,
			percent: 40,
		}),
		getSystemPrompt: () =>
			[
				"Base Pi system prompt text with prompt guidelines and appended system-prompt text.",
				"Read files",
				"Run shell commands",
				"Project guidance",
				"Use TDD",
			].join("\n"),
		getSystemPromptOptions: () => ({
			cwd: "/repo",
			selectedTools: ["read", "bash"],
			toolSnippets: { read: "Read files", bash: "Run shell commands" },
			contextFiles: [{ path: "/repo/AGENTS.md", content: "Project guidance" }],
			skills: [
				{
					name: "implement",
					description: "Implement work",
					content: "Use TDD",
				},
			],
		}),
		sessionManager: {
			buildContextEntries: () => [
				{
					type: "message",
					message: {
						role: "user",
						content: [{ type: "text", text: "Please inspect context" }],
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Sure" }],
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "read",
						content: [{ type: "text", text: "file output" }],
					},
				},
			],
		},
		ui: {
			notify: () => {},
			custom: async () => undefined,
		},
		...overrides,
	} as any;
}

test("registers /context-inspector with the required description", () => {
	let command: any;
	extension({
		registerCommand(name: string, options: unknown) {
			command = { name, ...(options as object) };
		},
	} as any);

	assert.equal(command.name, "context-inspector");
	assert.equal(
		command.description,
		"Inspect estimated Pi context usage by source.",
	);
});

test("command collects an active snapshot without waiting for Pi to become idle", async () => {
	let command: any;
	extension({
		registerCommand(_name: string, options: unknown) {
			command = options;
		},
	} as any);

	let collectedWhileActive = false;
	const ctx = makeCommandContext({
		isIdle: () => false,
		waitForIdle: () => {
			throw new Error("waitForIdle should not be called");
		},
		getContextUsage: () => {
			collectedWhileActive = true;
			return { tokens: 10, contextWindow: 100, percent: 10 };
		},
	});

	await command.handler("", ctx);

	assert.equal(collectedWhileActive, true);
});

test("collectContextInspectorInputs captures model, usage, prompt options, and active context entries", () => {
	const inputs = collectContextInspectorInputs(makeCommandContext());

	assert.deepEqual(inputs.model, {
		id: "gpt-test",
		provider: "openai",
		contextWindow: 128000,
	});
	assert.deepEqual(inputs.contextUsage, {
		tokens: 51200,
		contextWindow: 128000,
		percent: 40,
	});
	assert.match(inputs.systemPrompt, /Base Pi system prompt text/);
	assert.equal(
		inputs.systemPromptOptions.contextFiles?.[0]?.path,
		"/repo/AGENTS.md",
	);
	assert.equal(inputs.entries.length, 3);
	assert.equal(inputs.idle, false);
});

test("estimateContextAttribution uses canonical bucket labels and contributor names without raw snippets", () => {
	const estimate = estimateContextAttribution(
		collectContextInspectorInputs(makeCommandContext()),
	);

	assert.ok(estimate.buckets.some((bucket) => bucket.name === "System prompt"));
	assert.ok(
		estimate.buckets.some((bucket) => bucket.name === "Tool definitions"),
	);
	assert.ok(estimate.buckets.some((bucket) => bucket.name === "Context files"));
	assert.ok(estimate.buckets.some((bucket) => bucket.name === "Skills"));
	assert.ok(estimate.buckets.some((bucket) => bucket.name === "User messages"));
	assert.ok(
		estimate.buckets.some((bucket) => bucket.name === "Assistant messages"),
	);
	assert.ok(estimate.buckets.some((bucket) => bucket.name === "Tool results"));

	const contextFiles = estimate.buckets.find(
		(bucket) => bucket.name === "Context files",
	)!;
	assert.equal(contextFiles.contributors[0]?.name, "/repo/AGENTS.md");
	assert.doesNotMatch(
		JSON.stringify(estimate),
		/Project guidance|Read files|Use TDD/,
	);
});

test("showContextInspectorReport opens a read-only scrollable TUI overlay", async () => {
	let component: any;
	let options: any;
	let renderRequests = 0;
	let closed = false;
	const ctx = makeCommandContext({
		mode: "tui",
		hasUI: true,
		ui: {
			notify: () =>
				assert.fail(
					"TUI mode with UI should use the overlay, not fallback notification",
				),
			custom: async (factory: any, customOptions: any) => {
				options = customOptions;
				component = factory(
					{
						requestRender: () => {
							renderRequests += 1;
						},
					},
					{
						fg: (_color: string, text: string) => text,
						bold: (text: string) => text,
					},
					{},
					() => {
						closed = true;
					},
				);
			},
		},
	});
	const report = Array.from(
		{ length: 30 },
		(_, index) => `report line ${index + 1}`,
	).join("\n");

	await showContextInspectorReport(ctx, report);

	assert.equal(options.overlay, true);
	assert.equal(options.overlayOptions.anchor, "center");
	assert.equal(options.overlayOptions.maxHeight, "80%");
	const initialRender = component.render(80);
	assert.match(initialRender[0], /^┌─+┐$/);
	assert.match(initialRender.at(-1), /^└─+┘$/);
	assert.match(initialRender.join("\n"), /│ Context Inspector\s+│/);
	assert.match(
		initialRender.join("\n"),
		/│ esc\/enter closes • ↑↓ scroll .* 1-24\/30\s+│/,
	);
	assert.match(initialRender.join("\n"), /│ report line 1\s+│/);
	assert.match(initialRender.join("\n"), /│ report line 24\s+│/);
	assert.doesNotMatch(initialRender.join("\n"), /report line 25/);
	assert.equal(
		initialRender.filter((line: string) => /report line \d+/.test(line)).length,
		24,
	);

	component.handleInput("\x1b[B");
	assert.equal(renderRequests, 1);
	assert.doesNotMatch(component.render(80).join("\n"), /│ report line 1\s+│/);
	assert.match(component.render(80).join("\n"), /│ report line 2\s+│/);

	component.handleInput("\x1b[A");
	assert.match(component.render(80).join("\n"), /│ report line 1\s+│/);

	for (let i = 0; i < 100; i += 1) component.handleInput("\x1b[B");
	const lastPageRender = component.render(80).join("\n");
	assert.match(
		lastPageRender,
		/│ esc\/enter closes • ↑↓ scroll .* 7-30\/30\s+│/,
	);
	assert.doesNotMatch(lastPageRender, /│ report line 6\s+│/);
	assert.match(lastPageRender, /│ report line 30\s+│/);

	component.handleInput("\r");
	assert.equal(closed, true);
});

test("showContextInspectorReport uses the styled report in the TUI overlay", async () => {
	let component: any;
	const ctx = makeCommandContext({
		mode: "tui",
		hasUI: true,
		ui: {
			notify: () =>
				assert.fail(
					"TUI mode with UI should use the overlay, not fallback notification",
				),
			custom: async (factory: any) => {
				component = factory(
					{ requestRender: () => {} },
					{
						fg: (color: string, text: string) =>
							color === "accent" ? `<accent>${text}</accent>` : text,
						bold: (text: string) => text,
					},
					{},
					() => {},
				);
			},
		},
	});

	await showContextInspectorReport(ctx, {
		plain: "plain value",
		renderTui: (colorValue) => `styled ${colorValue("dynamic value")}`,
	});

	const rendered = component.render(120).join("\n");
	assert.match(rendered, /styled <accent>dynamic value<\/accent>/);
	assert.doesNotMatch(rendered, /plain value/);
});

test("showContextInspectorReport falls back to a compact notification when full TUI display is unavailable", async () => {
	let notification = "";
	const ctx = makeCommandContext({
		mode: "rpc",
		hasUI: true,
		ui: {
			notify: (message: string) => {
				notification = message;
			},
			custom: async () => assert.fail("non-TUI mode must not open custom UI"),
		},
	});

	await showContextInspectorReport(ctx, {
		plain: `# Context Inspector\n${"verbose body ".repeat(200)}`,
		renderTui: () => {
			throw new Error("fallback should not render TUI report");
		},
	});

	assert.match(notification, /^Context Inspector: report ready/);
	assert.ok(notification.length < 160);
	assert.doesNotMatch(notification, /verbose body/);
});

test("showContextInspectorReport exits quietly when no UI is available", async () => {
	const ctx = makeCommandContext({
		mode: "print",
		hasUI: false,
		ui: {
			notify: () => assert.fail("no-UI mode must not notify"),
			custom: async () => assert.fail("no-UI mode must not open custom UI"),
		},
	});

	await showContextInspectorReport(ctx, "# Context Inspector");
});

test("renderTuiContextInspectorReport colors only dynamic values", () => {
	const inputs = collectContextInspectorInputs(
		makeCommandContext({
			getContextUsage: () => ({
				tokens: null,
				contextWindow: undefined,
				percent: null,
			}),
			model: undefined,
		}),
	);
	const attribution = estimateContextAttribution(inputs);

	const plain = renderContextInspectorReport(inputs, attribution);
	const styled = renderTuiContextInspectorReport(
		inputs,
		attribution,
		(value) => `<accent>${value}</accent>`,
	);

	assert.doesNotMatch(plain, /<accent>/);
	assert.match(
		styled,
		/Collected: <accent>[^<]+ \(active at collection time\)<\/accent>/,
	);
	assert.match(styled, /Model: <accent>unknown<\/accent>/);
	assert.match(styled, /Context window: <accent>unknown<\/accent>/);
	assert.match(styled, /Pi authoritative total: <accent>unknown<\/accent>/);
	assert.match(styled, /Percentage: <accent>unknown<\/accent>/);
	assert.match(
		styled,
		/Estimated sum of visible sources: <accent>\d+ tokens<\/accent>/,
	);
	assert.match(
		styled,
		/- System prompt: <accent>~\d+ tokens<\/accent> <accent>\(\d+\.\d%\)<\/accent>/,
	);
	assert.doesNotMatch(styled, /<accent>System prompt<\/accent>/);
	assert.doesNotMatch(styled, /<accent># Context Inspector<\/accent>/);
	assert.doesNotMatch(styled, /<accent>Point-in-time active context snapshot/);
});

test("renderContextInspectorReport shows known Pi total and frames attribution as estimated", () => {
	const report = renderContextInspectorReport(
		collectContextInspectorInputs(makeCommandContext()),
		estimateContextAttribution(
			collectContextInspectorInputs(makeCommandContext()),
		),
	);

	assert.match(report, /Point-in-time active context snapshot/);
	assert.match(report, /Model: openai\/gpt-test/);
	assert.match(report, /Context window: 128k tokens/);
	assert.match(report, /Pi authoritative total: 51k tokens \(40\.0%\)/);
	assert.match(report, /Source attribution below is estimated/);
	assert.match(report, /\(\d+\.\d%\)/);
});

test("known Pi total scales bucket estimates and shares use the authoritative total", () => {
	const inputs = collectContextInspectorInputs(
		makeCommandContext({
			getContextUsage: () => ({ tokens: 60, contextWindow: 1000, percent: 6 }),
			getSystemPrompt: () => "A".repeat(40) + "B".repeat(20),
			getSystemPromptOptions: () => ({
				cwd: "/repo",
				selectedTools: [],
				contextFiles: [{ path: "/repo/large.md", content: "A".repeat(40) }],
				skills: [{ name: "small", content: "B".repeat(20) }],
			}),
			sessionManager: { buildContextEntries: () => [] },
		}),
	);

	const estimate = estimateContextAttribution(inputs);

	assert.equal(estimate.estimatedTotalTokens, 60);
	assert.deepEqual(
		estimate.buckets.map((bucket) => [
			bucket.name,
			bucket.estimatedTokens,
			bucket.sharePercent,
		]),
		[
			["Context files", 40, 66.66666666666666],
			["Skills", 20, 33.33333333333333],
		],
	);
});

test("unknown total leaves estimates unscaled and shares use the unscaled estimate total", () => {
	const inputs = collectContextInspectorInputs(
		makeCommandContext({
			getContextUsage: () => ({
				tokens: null,
				contextWindow: 200000,
				percent: null,
			}),
			getSystemPrompt: () => "A".repeat(40) + "B".repeat(20),
			getSystemPromptOptions: () => ({
				cwd: "/repo",
				selectedTools: [],
				contextFiles: [{ path: "/repo/large.md", content: "A".repeat(40) }],
				skills: [{ name: "small", content: "B".repeat(20) }],
			}),
			sessionManager: { buildContextEntries: () => [] },
		}),
	);

	const estimate = estimateContextAttribution(inputs);
	const report = renderContextInspectorReport(inputs, estimate);

	assert.equal(estimate.estimatedTotalTokens, 15);
	assert.deepEqual(
		estimate.buckets.map((bucket) => [
			bucket.name,
			bucket.estimatedTokens,
			bucket.sharePercent,
		]),
		[
			["Context files", 10, 66.66666666666666],
			["Skills", 5, 33.33333333333333],
		],
	);
	assert.match(report, /Pi authoritative total: unknown/);
	assert.match(report, /Percentage: unknown/);
	assert.match(report, /Context window: 200k tokens/);
	assert.match(
		report,
		/Pi total is unknown; source shares use the unscaled visible-source estimate as their denominator\./,
	);
});

test("zero buckets are hidden and nonzero buckets are sorted by estimated token count descending", () => {
	const inputs = collectContextInspectorInputs(
		makeCommandContext({
			getContextUsage: () => ({
				tokens: null,
				contextWindow: 1000,
				percent: null,
			}),
			getSystemPrompt: () => "B".repeat(16) + "C".repeat(8),
			getSystemPromptOptions: () => ({
				cwd: "/repo",
				selectedTools: [],
				appendSystemPrompt: "",
				contextFiles: [{ path: "/repo/medium.md", content: "C".repeat(8) }],
				skills: [{ name: "large", content: "B".repeat(16) }],
			}),
			sessionManager: {
				buildContextEntries: () => [
					{
						type: "message",
						message: { role: "user", content: "A".repeat(4) },
					},
				],
			},
		}),
	);

	const estimate = estimateContextAttribution(inputs);

	assert.deepEqual(
		estimate.buckets.map((bucket) => [bucket.name, bucket.estimatedTokens]),
		[
			["Skills", 4],
			["Context files", 2],
			["User messages", 1],
		],
	);
	assert.equal(
		estimate.buckets.some((bucket) => bucket.estimatedTokens === 0),
		false,
	);
	assert.equal(
		estimate.buckets.some((bucket) => bucket.name === "System prompt"),
		false,
	);
});

test("System prompt attribution excludes prompt sources with dedicated buckets", () => {
	const marker = "x".repeat(80);
	const systemPrompt = [
		"base system prompt text",
		"guideline text",
		"appended text",
		`tool snippet ${marker}`,
		`context file ${marker}`,
		`skill body ${marker}`,
	].join("\n");
	const inputs = collectContextInspectorInputs(
		makeCommandContext({
			getSystemPrompt: () => systemPrompt,
			getSystemPromptOptions: () => ({
				cwd: "/repo",
				selectedTools: ["read"],
				toolSnippets: { read: `tool snippet ${marker}` },
				promptGuidelines: ["guideline text"],
				appendSystemPrompt: "appended text",
				contextFiles: [
					{ path: "/repo/CONTEXT.md", content: `context file ${marker}` },
				],
				skills: [{ name: "implement", content: `skill body ${marker}` }],
			}),
			sessionManager: { buildContextEntries: () => [] },
		}),
	);

	const estimate = estimateContextAttribution(inputs);
	const byName = Object.fromEntries(
		estimate.buckets.map((bucket) => [bucket.name, bucket]),
	);

	assert.ok(
		byName["System prompt"].estimatedTokens <
			byName["Tool definitions"].estimatedTokens,
	);
	assert.ok(
		byName["System prompt"].estimatedTokens <
			byName["Context files"].estimatedTokens,
	);
	assert.ok(
		byName["System prompt"].estimatedTokens < byName.Skills.estimatedTokens,
	);
	assert.deepEqual(
		byName["System prompt"].contributors.map((item) => item.name).sort(),
		[
			"Appended system prompt",
			"Base Pi system prompt text",
			"Prompt guidelines",
		],
	);
});

test("System prompt bucket is omitted when all prompt text belongs to dedicated files, skills, and tools", () => {
	const marker = "dedicated prompt input ".repeat(8);
	const inputs = collectContextInspectorInputs(
		makeCommandContext({
			getSystemPrompt: () =>
				[`tool ${marker}`, `context ${marker}`, `skill ${marker}`].join("\n"),
			getSystemPromptOptions: () => ({
				cwd: "/repo",
				selectedTools: ["read"],
				toolSnippets: { read: `tool ${marker}` },
				contextFiles: [
					{ path: "/repo/CONTEXT.md", content: `context ${marker}` },
				],
				skills: [{ name: "implement", content: `skill ${marker}` }],
			}),
			sessionManager: { buildContextEntries: () => [] },
		}),
	);

	const estimate = estimateContextAttribution(inputs);

	assert.equal(
		estimate.buckets.some((bucket) => bucket.name === "System prompt"),
		false,
	);
});

test("Tool definitions ignore snippets for tools that are not active", () => {
	const inactiveSnippet = "inactive raw snippet ".repeat(8);
	const inputs = collectContextInspectorInputs(
		makeCommandContext({
			getSystemPrompt: () => ["base prompt text", "active snippet"].join("\n"),
			getSystemPromptOptions: () => ({
				cwd: "/repo",
				selectedTools: ["read"],
				toolSnippets: { read: "active snippet", write: inactiveSnippet },
			}),
			sessionManager: { buildContextEntries: () => [] },
		}),
	);

	const estimate = estimateContextAttribution(inputs);
	const tools = estimate.buckets.find(
		(bucket) => bucket.name === "Tool definitions",
	)!;

	assert.deepEqual(
		tools.contributors.map((item) => item.name),
		["read"],
	);
	assert.doesNotMatch(JSON.stringify(estimate), /write|inactive raw snippet/);
});

test("Tool definitions use active tool names and report caveats about provider schemas", () => {
	const inputs = collectContextInspectorInputs(
		makeCommandContext({
			getSystemPromptOptions: () => ({
				cwd: "/repo",
				selectedTools: ["read", "customTool"],
				toolSnippets: { read: "Read files without exposing this raw snippet" },
			}),
			sessionManager: { buildContextEntries: () => [] },
		}),
	);

	const estimate = estimateContextAttribution(inputs);
	const tools = estimate.buckets.find(
		(bucket) => bucket.name === "Tool definitions",
	)!;
	assert.deepEqual(tools.contributors.map((item) => item.name).sort(), [
		"customTool",
		"read",
	]);

	const report = renderContextInspectorReport(inputs, estimate);
	assert.match(
		report,
		/Tool definitions are estimated from prompt-visible names and snippets, not provider-serialized schemas\./,
	);
	assert.doesNotMatch(report, /Read files without exposing this raw snippet/);
});

test("contributor names are safe names or paths", () => {
	const inputs = collectContextInspectorInputs(
		makeCommandContext({
			getSystemPromptOptions: () => ({
				cwd: "/repo",
				selectedTools: ["read\nRAW CONTENT"],
				toolSnippets: { "read\nRAW CONTENT": "tool details" },
				contextFiles: [
					{ path: "/repo/SECRET.md\nraw file body", content: "raw file body" },
				],
				skills: [{ name: "skill\nraw body", content: "raw body" }],
			}),
			sessionManager: { buildContextEntries: () => [] },
		}),
	);

	const serialized = JSON.stringify(estimateContextAttribution(inputs));
	assert.doesNotMatch(serialized, /\n|RAW CONTENT|raw file body|raw body/);
	assert.match(serialized, /"read"/);
	assert.match(serialized, /\/repo\/SECRET\.md/);
	assert.match(serialized, /"skill"/);
});

test("conversation attribution uses only active branch context entries", () => {
	const inputs = collectContextInspectorInputs(
		makeCommandContext({
			sessionManager: {
				buildContextEntries: () => [
					{
						type: "message",
						message: { role: "user", content: "active user request" },
					},
					{
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "active assistant reply" }],
						},
					},
					{
						type: "message",
						message: {
							role: "toolResult",
							toolName: "read",
							content: [{ type: "text", text: "active tool output" }],
						},
					},
				],
				getEntries: () => [
					{
						type: "message",
						message: { role: "user", content: "abandoned branch user content" },
					},
					{
						type: "message",
						message: {
							role: "assistant",
							content: [
								{ type: "text", text: "abandoned branch assistant content" },
							],
						},
					},
				],
			},
		}),
	);

	const estimate = estimateContextAttribution(inputs);
	const byName = Object.fromEntries(
		estimate.buckets.map((bucket) => [bucket.name, bucket]),
	);

	assert.ok(byName["User messages"].estimatedTokens > 0);
	assert.ok(byName["Assistant messages"].estimatedTokens > 0);
	assert.ok(byName["Tool results"].estimatedTokens > 0);
	assert.doesNotMatch(
		JSON.stringify(estimate),
		/abandoned branch|active user request|active assistant reply|active tool output/,
	);
});

test("compaction attribution counts summary text and retained active messages, not token metadata", () => {
	const inputs = collectContextInspectorInputs(
		makeCommandContext({
			getContextUsage: () => ({
				tokens: null,
				contextWindow: 128000,
				percent: null,
			}),
			sessionManager: {
				buildContextEntries: () => [
					{
						type: "compaction",
						summary: "short remaining summary",
						tokensBefore: 100_000,
						retainedTail: [
							{ role: "user", content: "retained user text" },
							{
								role: "assistant",
								content: [{ type: "text", text: "retained assistant text" }],
							},
						],
					},
				],
			},
		}),
	);

	const estimate = estimateContextAttribution(inputs);
	const byName = Object.fromEntries(
		estimate.buckets.map((bucket) => [bucket.name, bucket]),
	);

	assert.ok(byName["Compactions and summaries"].estimatedTokens < 1000);
	assert.equal(
		byName["Compactions and summaries"].contributors[0]?.name,
		"compaction",
	);
	assert.ok(byName["User messages"].estimatedTokens > 0);
	assert.ok(byName["Assistant messages"].estimatedTokens > 0);
	assert.doesNotMatch(
		JSON.stringify(estimate),
		/100000|retained user text|retained assistant text|short remaining summary/,
	);
});

test("custom context messages are attributed to other active entries with safe custom labels", () => {
	const inputs = collectContextInspectorInputs(
		makeCommandContext({
			sessionManager: {
				buildContextEntries: () => [
					{
						type: "custom_message",
						customType: "extension\nraw custom label",
						content: "custom message body",
					},
				],
			},
		}),
	);

	const estimate = estimateContextAttribution(inputs);
	const other = estimate.buckets.find(
		(bucket) => bucket.name === "Other active entries",
	)!;

	assert.equal(other.contributors[0]?.name, "extension");
	assert.doesNotMatch(
		JSON.stringify(estimate),
		/raw custom label|custom message body/,
	);
});

test("message and tool-result contributors use labels without raw content snippets", () => {
	const inputs = collectContextInspectorInputs(
		makeCommandContext({
			sessionManager: {
				buildContextEntries: () => [
					{
						type: "message",
						message: { role: "user", content: "secret user snippet" },
					},
					{
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "secret assistant snippet" }],
						},
					},
					{
						type: "message",
						message: {
							role: "toolResult",
							toolName: "bash\nsecret tool label",
							content: [{ type: "text", text: "secret tool output" }],
						},
					},
					{
						type: "message",
						message: {
							role: "toolResult",
							content: [{ type: "text", text: "anonymous tool output" }],
						},
					},
				],
			},
		}),
	);

	const estimate = estimateContextAttribution(inputs);
	const serialized = JSON.stringify(estimate);

	assert.match(serialized, /user message/);
	assert.match(serialized, /assistant message/);
	assert.match(serialized, /bash/);
	assert.match(serialized, /tool result/);
	assert.doesNotMatch(
		serialized,
		/secret user snippet|secret assistant snippet|secret tool output|secret tool label|anonymous tool output/,
	);
});

test("rendered contributor lists are capped at five and shown only for materially large buckets", () => {
	const contextFiles = Array.from({ length: 7 }, (_, index) => ({
		path: `/repo/context-${index + 1}.md`,
		content: "large context file body ".repeat(250 - index * 10),
	}));
	const inputs = collectContextInspectorInputs(
		makeCommandContext({
			getContextUsage: () => ({
				tokens: null,
				contextWindow: 128000,
				percent: null,
			}),
			getSystemPrompt: () =>
				contextFiles.map((file) => file.content).join("\n") +
				"\nsmall user note",
			getSystemPromptOptions: () => ({
				cwd: "/repo",
				selectedTools: [],
				contextFiles,
			}),
			sessionManager: {
				buildContextEntries: () => [
					{
						type: "message",
						message: { role: "user", content: "small user note" },
					},
				],
			},
		}),
	);

	const report = renderContextInspectorReport(
		inputs,
		estimateContextAttribution(inputs),
	);

	assert.match(report, /- Context files: ~\d/);
	assert.match(report, / {2}- \/repo\/context-1\.md: ~\d/);
	assert.match(report, / {2}- \/repo\/context-5\.md: ~\d/);
	assert.doesNotMatch(report, / {2}- \/repo\/context-6\.md: ~\d/);
	assert.match(report, /- User messages: ~4 tokens/);
	assert.doesNotMatch(report, / {2}- user message:/);
});

test("recommendations are read-only plain text for large context files, skills, and tool results", () => {
	const inputs = collectContextInspectorInputs(
		makeCommandContext({
			getContextUsage: () => ({
				tokens: null,
				contextWindow: 128000,
				percent: null,
			}),
			getSystemPrompt: () =>
				[
					"context file ".repeat(500),
					"skill body ".repeat(500),
					"tool output ".repeat(500),
				].join("\n"),
			getSystemPromptOptions: () => ({
				cwd: "/repo",
				selectedTools: [],
				contextFiles: [
					{ path: "/repo/LARGE.md", content: "context file ".repeat(500) },
				],
				skills: [{ name: "large-skill", content: "skill body ".repeat(500) }],
			}),
			sessionManager: {
				buildContextEntries: () => [
					{
						type: "message",
						message: {
							role: "toolResult",
							toolName: "bash",
							content: "tool output ".repeat(500),
						},
					},
				],
			},
		}),
	);

	const report = renderContextInspectorReport(
		inputs,
		estimateContextAttribution(inputs),
	);

	assert.match(report, /## Read-only recommendations/);
	assert.match(
		report,
		/Large tool results: review whether bulky outputs still need to remain in active context/,
	);
	assert.match(
		report,
		/Large context files: consider whether the current project context can be narrowed/,
	);
	assert.match(
		report,
		/Large skills: consider whether every loaded skill is relevant to the current task/,
	);
	assert.doesNotMatch(
		report,
		/button|click|trigger|compact now|edit|apply|prune/i,
	);
	assert.doesNotMatch(
		report,
		/context file context file|skill body skill body|tool output tool output/,
	);
});
