// biome-ignore-all lint/style/noMagicNumbers: Test literals define editor cursor positions.
import { expect, test } from "vitest";
import {
	createFileMentionAutocompleteProvider,
	extractActiveAtQuery,
	type AutocompleteItem,
	type AutocompleteProvider,
} from "../../../extensions/autocomplete.ts";
import type { FileMentionIndexProvider } from "../../../extensions/indexer.ts";
import type { FileMentionIndex } from "../../../extensions/matcher.ts";

function currentProvider(
	items: Array<AutocompleteItem> = [],
): AutocompleteProvider & {
	suggestionCalls: number;
	applyCalls: number;
} {
	return {
		triggerCharacters: ["/"],
		suggestionCalls: 0,
		applyCalls: 0,
		async getSuggestions() {
			this.suggestionCalls += 1;
			return { prefix: "@", items };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			this.applyCalls += 1;
			const line = lines[cursorLine] ?? "";
			return {
				lines: [
					`${line.slice(0, cursorCol - prefix.length)}${item.value}${line.slice(
						cursorCol,
					)}`,
				],
				cursorLine,
				cursorCol: cursorCol - prefix.length + item.value.length,
			};
		},
	};
}

function indexProvider(
	index: FileMentionIndex | null,
): FileMentionIndexProvider {
	return {
		getIndex: async () => index,
		getCachedIndex: () => index,
		refresh: async () => index,
		clear: () => undefined,
	};
}

const index: FileMentionIndex = {
	projectRoot: "/repo",
	entries: [
		{
			kind: "directory",
			path: "src/components",
			depth: 2,
			basename: "components",
		},
		{
			kind: "file",
			path: "src/components/Button.tsx",
			depth: 3,
			basename: "Button.tsx",
		},
	],
};

test("when a non-bare @ query has File Mentions, smart suggestions replace native suggestions", async () => {
	const native = currentProvider([{ value: "native", label: "native" }]);
	const provider = createFileMentionAutocompleteProvider(
		native,
		indexProvider(index),
	);

	const result = await provider.getSuggestions(["open @comp"], 0, 10, {
		signal: new AbortController().signal,
	});

	expect(native.suggestionCalls).toBe(0);
	expect(result?.prefix).toBe("@comp");
	expect(result?.items.map((item) => item.value)).toEqual([
		"@src/components",
		"@src/components/Button.tsx",
	]);
});

test("when applying a smart File Mention, the prepared insertion value replaces the active prefix", async () => {
	const native = currentProvider();
	const provider = createFileMentionAutocompleteProvider(
		native,
		indexProvider(index),
	);
	const result = await provider.getSuggestions(["open @comp please"], 0, 10, {
		signal: new AbortController().signal,
	});
	expect(result).toBeTruthy();
	if (!result) {
		throw new Error("expected file mention suggestions");
	}

	const applied = provider.applyCompletion(
		["open @comp please"],
		0,
		10,
		result.items[0],
		result.prefix,
	);

	expect(applied).toEqual({
		lines: ["open @src/components please"],
		cursorLine: 0,
		cursorCol: 20,
	});
	expect(native.applyCalls).toBe(0);
});

test("when the @ query is bare, native autocomplete is used as fallback", async () => {
	const native = currentProvider([{ value: "native", label: "native" }]);
	const provider = createFileMentionAutocompleteProvider(
		native,
		indexProvider(index),
	);

	const bare = await provider.getSuggestions(["open @"], 0, 6, {
		signal: new AbortController().signal,
	});

	expect(native.suggestionCalls).toBe(1);
	expect(bare?.items).toEqual([{ value: "native", label: "native" }]);
});

test("when smart matching is empty, native @ autocomplete is not used as fallback", async () => {
	const native = currentProvider([{ value: "native", label: "native" }]);
	const provider = createFileMentionAutocompleteProvider(
		native,
		indexProvider(index),
	);

	const result = await provider.getSuggestions(["open @zzz"], 0, 9, {
		signal: new AbortController().signal,
	});

	expect(result).toBe(null);
	expect(native.suggestionCalls).toBe(0);
});

test("when the File Mention Index is not ready, autocomplete cancels without starting indexing", async () => {
	const native = currentProvider([{ value: "native", label: "native" }]);
	let getIndexCalls = 0;
	const provider = createFileMentionAutocompleteProvider(native, {
		getIndex: async () => {
			getIndexCalls += 1;
			return index;
		},
		getCachedIndex: () => null,
		refresh: async () => null,
		clear: () => undefined,
	});

	const result = await provider.getSuggestions(["@forge"], 0, 6, {
		signal: new AbortController().signal,
	});

	expect(result).toBe(null);
	expect(getIndexCalls).toBe(0);
	expect(native.suggestionCalls).toBe(0);
});

test("when an otherwise empty input is in an @ mention context, native autocomplete is not used", async () => {
	const native = currentProvider([{ value: "native", label: "native" }]);
	const provider = createFileMentionAutocompleteProvider(
		native,
		indexProvider(index),
	);

	const bare = await provider.getSuggestions(["@"], 0, 1, {
		signal: new AbortController().signal,
	});
	const spaced = await provider.getSuggestions(["@ "], 0, 2, {
		signal: new AbortController().signal,
	});

	expect(bare).toBe(null);
	expect(spaced).toBe(null);
	expect(native.suggestionCalls).toBe(0);
});

test("when not in an active @ file mention query, native autocomplete handles the request", async () => {
	const native = currentProvider([{ value: "native", label: "native" }]);
	const provider = createFileMentionAutocompleteProvider(
		native,
		indexProvider(index),
	);

	await provider.getSuggestions(["/help"], 0, 5, {
		signal: new AbortController().signal,
	});
	await provider.getSuggestions(["email me@example.com"], 0, 20, {
		signal: new AbortController().signal,
	});

	expect(native.suggestionCalls).toBe(2);
});

test("when active @ query detection sees token boundaries and quotes, only file mentions match", () => {
	expect(extractActiveAtQuery(["see @src/lib"], 0, 12)).toEqual({
		prefix: "@src/lib",
		query: "src/lib",
	});
	expect(extractActiveAtQuery(['see @"docs/my file'], 0, 18)).toEqual({
		prefix: '@"docs/my file',
		query: '"docs/my file',
	});
	expect(extractActiveAtQuery(["see abc@src"], 0, 11)).toBe(null);
	expect(extractActiveAtQuery(["see @src and"], 0, 12)).toBe(null);
	expect(extractActiveAtQuery(['see @"docs/my file" and'], 0, 24)).toBe(null);
});
