// biome-ignore-all lint/style/noMagicNumbers: Test literals describe expected widget and parser behavior.
// biome-ignore-all lint/suspicious/noExplicitAny: Tests use partial extension API fixtures.
import { expect, test } from "vitest";
import extension, {
	MAX_SUGGESTIONS,
	normalizeSuggestions,
	parseSuggestionNumber,
	renderSuggestedRepliesWidget,
	wrapIndex,
	WIDGET_ID,
} from "../../../extensions/index.ts";

test("registers suggested replies tool, commands, and shortcuts", () => {
	const tools: Array<any> = [];
	const commands: Array<string> = [];
	const shortcuts: Array<string> = [];

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

	expect(tools[0]?.name).toBe("suggest_replies");
	expect(commands).toEqual(["suggested-replies-demo", "suggested-reply"]);
	expect(shortcuts).toEqual(["f7", "f8"]);
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

	expect(widgetId).toBe(WIDGET_ID);
	expect(result.content[0].text).toMatch(/Suggested replies displayed/);
	expect(result.details.suggestions).toEqual([
		{ label: "Yes, agree" },
		{ label: "Show alternatives" },
	]);
	expect(widgetFactory().render(120).join("\n")).toMatch(
		/┌─+┐\n {2}Suggested replies\n {2}› 1\. Yes, agree/,
	);
	expect(
		widgetFactory(undefined, {
			fg: (_color: "borderMuted", text: string) => `<border>${text}</border>`,
		}).render(120)[0],
	).toMatch(/^<border>┌─+┐<\/border>$/);
});

test("normalizes suggestions by trimming, dropping empty labels, and capping at nine", () => {
	const suggestions = Array.from(
		{ length: MAX_SUGGESTIONS + 2 },
		(_, index) => ({
			label: ` Reply ${index + 1} `,
		}),
	);

	const normalized = normalizeSuggestions([{ label: "   " }, ...suggestions]);

	expect(normalized.length).toBe(MAX_SUGGESTIONS);
	expect(normalized[0]).toEqual({ label: "Reply 1" });
	expect(normalized.at(-1)?.label).toBe("Reply 9");
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

	expect(lines).toEqual([
		"┌──────────────────────────────┐",
		"  Suggested replies",
		"    1. Yes, agree",
		"  › 2. Show alternatives first",
		"  F7/F8 cycle • /suggested-reply…",
	]);
});

test("parses /suggested-reply numbers", () => {
	expect(parseSuggestionNumber("1")).toBe(0);
	expect(parseSuggestionNumber("9 please")).toBe(8);
	expect(parseSuggestionNumber("0")).toBe(undefined);
	expect(parseSuggestionNumber("10")).toBe(undefined);
	expect(parseSuggestionNumber("abc")).toBe(undefined);
});

test("wrapIndex wraps in both directions", () => {
	expect(wrapIndex(3, 3)).toBe(0);
	expect(wrapIndex(-1, 3)).toBe(2);
	expect(wrapIndex(1, 3)).toBe(1);
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
			if (name === "suggested-reply") {
				command = value;
			}
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

	expect(editorText).toBe("Second");
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

	const inserted: Array<string> = [];
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
	await shortcutHandlers.f8(ctx);
	await shortcutHandlers.f7(ctx);

	expect(inserted).toEqual(["Second", "First"]);
});
