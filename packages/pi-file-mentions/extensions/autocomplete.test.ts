// biome-ignore-all lint/style/noMagicNumbers: Test literals define editor cursor positions.
import assert from "node:assert/strict";
import test from "node:test";
import {
	createFileMentionAutocompleteProvider,
	extractActiveAtQuery,
	type AutocompleteItem,
	type AutocompleteProvider,
} from "./autocomplete.ts";
import type { FileMentionIndexProvider } from "./indexer.ts";
import type { FileMentionIndex } from "./matcher.ts";

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

	assert.equal(native.suggestionCalls, 0);
	assert.equal(result?.prefix, "@comp");
	assert.deepEqual(
		result?.items.map((item) => item.value),
		["@src/components", "@src/components/Button.tsx"],
	);
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
	assert.ok(result);

	const applied = provider.applyCompletion(
		["open @comp please"],
		0,
		10,
		result.items[0],
		result.prefix,
	);

	assert.deepEqual(applied, {
		lines: ["open @src/components please"],
		cursorLine: 0,
		cursorCol: 20,
	});
	assert.equal(native.applyCalls, 0);
});

test("when the @ query is bare or smart matching is empty, native autocomplete is used as fallback", async () => {
	const native = currentProvider([{ value: "native", label: "native" }]);
	const provider = createFileMentionAutocompleteProvider(
		native,
		indexProvider(index),
	);

	const bare = await provider.getSuggestions(["open @"], 0, 6, {
		signal: new AbortController().signal,
	});
	const empty = await provider.getSuggestions(["open @zzz"], 0, 9, {
		signal: new AbortController().signal,
	});

	assert.equal(native.suggestionCalls, 2);
	assert.deepEqual(bare?.items, [{ value: "native", label: "native" }]);
	assert.deepEqual(empty?.items, [{ value: "native", label: "native" }]);
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

	assert.equal(native.suggestionCalls, 2);
});

test("when active @ query detection sees token boundaries and quotes, only file mentions match", () => {
	assert.deepEqual(extractActiveAtQuery(["see @src/lib"], 0, 12), {
		prefix: "@src/lib",
		query: "src/lib",
	});
	assert.deepEqual(extractActiveAtQuery(['see @"docs/my file'], 0, 18), {
		prefix: '@"docs/my file',
		query: '"docs/my file',
	});
	assert.equal(extractActiveAtQuery(["see abc@src"], 0, 11), null);
	assert.equal(extractActiveAtQuery(["see @src and"], 0, 12), null);
	assert.equal(extractActiveAtQuery(['see @"docs/my file" and'], 0, 24), null);
});
