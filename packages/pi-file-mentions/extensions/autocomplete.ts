import type { FileMentionIndexProvider } from "./indexer.ts";
import { matchFileMentions } from "./matcher.ts";

export type AutocompleteItem = {
	value: string;
	label: string;
	description?: string;
};

export type AutocompleteSuggestions = {
	items: Array<AutocompleteItem>;
	prefix: string;
};

export type AutocompleteProvider = {
	triggerCharacters?: Array<string>;
	getSuggestions: (
		lines: Array<string>,
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	) => Promise<AutocompleteSuggestions | null>;
	applyCompletion: (
		lines: Array<string>,
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	) => { lines: Array<string>; cursorLine: number; cursorCol: number };
	shouldTriggerFileCompletion?: (
		lines: Array<string>,
		cursorLine: number,
		cursorCol: number,
	) => boolean;
};

const SMART_ITEM_DESCRIPTION = "File Mention";

type ActiveAtQuery = {
	prefix: string;
	query: string;
};

export function createFileMentionAutocompleteProvider(
	current: AutocompleteProvider,
	indexProvider: FileMentionIndexProvider,
): AutocompleteProvider {
	const smartItems = new WeakSet<AutocompleteItem>();

	return {
		triggerCharacters: Array.from(
			new Set([...(current.triggerCharacters ?? []), "@"]),
		),
		shouldTriggerFileCompletion:
			current.shouldTriggerFileCompletion?.bind(current),
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const activeQuery = extractActiveAtQuery(lines, cursorLine, cursorCol);
			if (
				isEmptyInputAtMentionContext(lines, cursorLine, cursorCol) &&
				(!activeQuery || isBareAtQuery(activeQuery))
			) {
				return null;
			}
			if (!activeQuery || isBareAtQuery(activeQuery)) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			try {
				const index = indexProvider.getCachedIndex();
				if (!index || options.signal.aborted) {
					return null;
				}

				const suggestions = matchFileMentions(index, activeQuery.query);
				if (suggestions.length === 0) {
					return null;
				}

				return {
					prefix: activeQuery.prefix,
					items: suggestions.map((suggestion) => {
						const item: AutocompleteItem = {
							value: suggestion.insertText,
							label: suggestion.path,
							description:
								suggestion.kind === "folder"
									? SMART_ITEM_DESCRIPTION
									: `File Mention in ${suggestion.matchedFolderPath}`,
						};
						smartItems.add(item);
						return item;
					}),
				};
			} catch {
				return null;
			}
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!smartItems.has(item)) {
				return current.applyCompletion(
					lines,
					cursorLine,
					cursorCol,
					item,
					prefix,
				);
			}

			return replacePrefixAtCursor(
				lines,
				cursorLine,
				cursorCol,
				prefix,
				item.value,
			);
		},
	};
}

export function extractActiveAtQuery(
	lines: Array<string>,
	cursorLine: number,
	cursorCol: number,
): ActiveAtQuery | null {
	const line = lines[cursorLine] ?? "";
	const beforeCursor = line.slice(0, cursorCol);
	const atIndex = findActiveAtIndex(beforeCursor);
	if (atIndex < 0) {
		return null;
	}
	const prefix = beforeCursor.slice(atIndex);
	return {
		prefix,
		query: prefix.slice(1),
	};
}

function findActiveAtIndex(beforeCursor: string): number {
	let index = beforeCursor.lastIndexOf("@");
	while (index >= 0) {
		const previous = beforeCursor[index - 1];
		if (index === 0 || /\s/.test(previous)) {
			const prefixAfterAt = beforeCursor.slice(index + 1);
			const quote = prefixAfterAt[0];
			if (quote === '"' || quote === "'") {
				return isActiveQuotedPrefix(prefixAfterAt, quote) ? index : -1;
			}
			if (!/\s/.test(prefixAfterAt)) {
				return index;
			}
		}

		if (index === 0) {
			break;
		}
		index = beforeCursor.lastIndexOf("@", index - 1);
	}
	return -1;
}

function isActiveQuotedPrefix(prefixAfterAt: string, quote: string): boolean {
	let escaped = false;
	for (let index = 1; index < prefixAfterAt.length; index += 1) {
		const char = prefixAfterAt[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === quote) {
			return index === prefixAfterAt.length - 1;
		}
	}
	return true;
}

function isBareAtQuery(activeQuery: ActiveAtQuery): boolean {
	const query = activeQuery.query.trim();
	return query === "" || query === '"' || query === "'";
}

function isEmptyInputAtMentionContext(
	lines: Array<string>,
	cursorLine: number,
	cursorCol: number,
): boolean {
	const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
	if (!beforeCursor.startsWith("@")) {
		return false;
	}

	return lines.every((line, index) => {
		if (index === cursorLine) {
			return line.slice(cursorCol).trim() === "";
		}
		return line.trim() === "";
	});
}

function replacePrefixAtCursor(
	lines: Array<string>,
	cursorLine: number,
	cursorCol: number,
	prefix: string,
	insertText: string,
): { lines: Array<string>; cursorLine: number; cursorCol: number } {
	const nextLines = [...lines];
	const line = nextLines[cursorLine] ?? "";
	const startCol = Math.max(0, cursorCol - prefix.length);
	nextLines[cursorLine] = `${line.slice(0, startCol)}${insertText}${line.slice(
		cursorCol,
	)}`;
	return {
		lines: nextLines,
		cursorLine,
		cursorCol: startCol + insertText.length,
	};
}
