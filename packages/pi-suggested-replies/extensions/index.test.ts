import assert from "node:assert/strict";
import test from "node:test";
import extension, {
	MAX_SUGGESTIONS,
	normalizeSuggestions,
	parseSuggestionNumber,
	renderSuggestedRepliesWidget,
	wrapIndex,
	WIDGET_ID,
} from "./index.ts";

test("registers suggested replies tool, commands, and shortcuts", () => {
	const tools: any[] = [];
	const commands: string[] = [];
	const shortcuts: string[] = [];

	extension({
		on() {},
		registerTool(tool: any) {
			tools.push(tool);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		registerShortcut(shortcut: string) {
			shortcuts.push(shortcut);
		},
	} as any);

	assert.equal(tools[0]?.name, "suggest_replies");
	assert.deepEqual(commands, ["suggested-replies-demo", "suggested-reply"]);
	assert.deepEqual(shortcuts, ["f7", "f8"]);
});

test("tool displays suggestions and returns immediately", async () => {
	let tool: any;
	extension({
		on() {},
		registerTool(value: any) {
			tool = value;
		},
		registerCommand() {},
		registerShortcut() {},
	} as any);

	let widgetId = "";
	let widgetFactory: any;
	const ctx = {
		ui: {
			setWidget(id: string, factory: any) {
				widgetId = id;
				widgetFactory = factory;
			},
		},
	};

	const result = await tool.execute(
		"call-1",
		{
			suggestions: [{ label: " Yes, agree " }, { label: "Show alternatives" }],
		},
		undefined,
		undefined,
		ctx,
	);

	assert.equal(widgetId, WIDGET_ID);
	assert.match(result.content[0].text, /Suggested replies displayed/);
	assert.deepEqual(result.details.suggestions, [
		{ label: "Yes, agree" },
		{ label: "Show alternatives" },
	]);
	assert.match(
		widgetFactory().render(120).join("\n"),
		/┌─+┐\n  Suggested replies\n  › 1\. Yes, agree/,
	);
	assert.match(
		widgetFactory(undefined, {
			fg: (_color: "borderMuted", text: string) => `<border>${text}</border>`,
		}).render(120)[0],
		/^<border>┌─+┐<\/border>$/,
	);
});

test("normalizes suggestions by trimming, dropping empty labels, and capping at nine", () => {
	const suggestions = Array.from(
		{ length: MAX_SUGGESTIONS + 2 },
		(_, index) => ({
			label: ` Reply ${index + 1} `,
		}),
	);

	const normalized = normalizeSuggestions([{ label: "   " }, ...suggestions]);

	assert.equal(normalized.length, MAX_SUGGESTIONS);
	assert.deepEqual(normalized[0], { label: "Reply 1" });
	assert.equal(normalized.at(-1)?.label, "Reply 9");
});

test("renders widget with selected marker, one-line suggestions, help text, and truncation", () => {
	const lines = renderSuggestedRepliesWidget(
		{
			selectedIndex: 1,
			suggestions: [
				{ label: "Yes, agree" },
				{ label: "Show alternatives first" },
			],
		},
		32,
	);

	assert.deepEqual(lines, [
		"┌──────────────────────────────┐",
		"  Suggested replies",
		"    1. Yes, agree",
		"  › 2. Show alternatives first",
		"  F7/F8 cycle • /suggested-reply…",
	]);
});

test("parses /suggested-reply numbers", () => {
	assert.equal(parseSuggestionNumber("1"), 0);
	assert.equal(parseSuggestionNumber("9 please"), 8);
	assert.equal(parseSuggestionNumber("0"), undefined);
	assert.equal(parseSuggestionNumber("10"), undefined);
	assert.equal(parseSuggestionNumber("abc"), undefined);
});

test("wrapIndex wraps in both directions", () => {
	assert.equal(wrapIndex(3, 3), 0);
	assert.equal(wrapIndex(-1, 3), 2);
	assert.equal(wrapIndex(1, 3), 1);
});

test("/suggested-reply inserts the selected suggestion into the editor", async () => {
	let tool: any;
	let command: any;
	extension({
		on() {},
		registerTool(value: any) {
			tool = value;
		},
		registerCommand(name: string, value: any) {
			if (name === "suggested-reply") command = value;
		},
		registerShortcut() {},
	} as any);

	let editorText = "";
	const ctx = {
		ui: {
			setWidget() {},
			setEditorText(value: string) {
				editorText = value;
			},
			notify() {},
		},
	};

	await tool.execute(
		"call-1",
		{ suggestions: [{ label: "First" }, { label: "Second" }] },
		undefined,
		undefined,
		ctx,
	);
	await command.handler("2", ctx);

	assert.equal(editorText, "Second");
});

test("function key shortcuts cycle suggestions and replace editor text", async () => {
	let tool: any;
	const shortcutHandlers: Record<string, any> = {};
	extension({
		on() {},
		registerTool(value: any) {
			tool = value;
		},
		registerCommand() {},
		registerShortcut(shortcut: string, value: any) {
			shortcutHandlers[shortcut] = value.handler;
		},
	} as any);

	const inserted: string[] = [];
	const ctx = {
		ui: {
			setWidget() {},
			setEditorText(value: string) {
				inserted.push(value);
			},
		},
	};

	await tool.execute(
		"call-1",
		{ suggestions: [{ label: "First" }, { label: "Second" }] },
		undefined,
		undefined,
		ctx,
	);
	await shortcutHandlers["f8"](ctx);
	await shortcutHandlers["f7"](ctx);

	assert.deepEqual(inserted, ["Second", "First"]);
});
