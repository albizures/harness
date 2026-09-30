const MAX_MATCHED_FOLDERS = 5;
const MAX_FILES_PER_FOLDER = 20;
const MAX_TOTAL_SUGGESTIONS = 50;
const BASENAME_MATCH_BONUS = 100;
const CONTIGUOUS_MATCH_BONUS = 20;
const PREFIX_MATCH_BONUS = 30;
const EXACT_MATCH_SCORE = 1000;
const PREFIX_MATCH_SCORE = 800;
const CONTAINS_MATCH_SCORE = 650;
const SUBSEQUENCE_MATCH_SCORE = 400;
const MINIMUM_FUZZY_SCORE = 1;

export type FileMentionIndexEntry = {
	kind: "file" | "directory";
	path: string;
	depth: number;
	basename: string;
	absolutePath?: string;
};

export type FileMentionIndex = {
	projectRoot: string;
	entries: Array<FileMentionIndexEntry>;
};

export type FileMentionSuggestion = {
	kind: "folder" | "file";
	path: string;
	absolutePath: string;
	score: number;
	insertText: string;
	matchedFolderPath?: string;
};

export type FileMentionInsertion = {
	insertText: string;
	pathValue: string;
	quoted: boolean;
	absolute: boolean;
};

export function matchFileMentions(
	index: FileMentionIndex,
	rawQuery: string,
): Array<FileMentionSuggestion> {
	const query = normalizeQuery(rawQuery);
	if (!query) {
		return [];
	}

	const entries = index.entries.map((entry) => normalizeEntry(index, entry));
	const files = entries.filter((entry) => entry.kind === "file");
	const matchedFolders = entries
		.filter((entry) => entry.kind === "directory")
		.map((entry) => ({ entry, score: scoreFolder(entry, query) }))
		.filter((match) => match.score > 0)
		.sort((a, b) => compareFolderMatches(a, b))
		.slice(0, MAX_MATCHED_FOLDERS);

	const suggestions: Array<FileMentionSuggestion> = [];
	for (const [folderIndex, { entry, score }] of matchedFolders.entries()) {
		if (suggestions.length >= MAX_TOTAL_SUGGESTIONS) {
			break;
		}

		const folderSuggestion = withInsertion(rawQuery, {
			kind: "folder",
			path: entry.path,
			absolutePath: entry.absolutePath,
			score,
			insertText: "",
		});
		suggestions.push(folderSuggestion);

		const remainingFolderSlots = matchedFolders.length - folderIndex - 1;
		const remainingTotal =
			MAX_TOTAL_SUGGESTIONS - suggestions.length - remainingFolderSlots;
		if (remainingTotal <= 0) {
			continue;
		}

		const expandedFiles = files
			.filter((file) => isDescendantPath(file.path, entry.path))
			.sort((a, b) => compareExpandedFiles(a, b))
			.slice(0, Math.min(MAX_FILES_PER_FOLDER, remainingTotal))
			.map((file) =>
				withInsertion(rawQuery, {
					kind: "file",
					path: file.path,
					absolutePath: file.absolutePath,
					score,
					insertText: "",
					matchedFolderPath: entry.path,
				}),
			);
		suggestions.push(...expandedFiles);
	}

	return suggestions;
}

export function prepareFileMentionInsertion(
	query: string,
	suggestion: Pick<FileMentionSuggestion, "path" | "absolutePath">,
): FileMentionInsertion {
	const quoted = isQuotedQuery(query);
	const absolute = isAbsoluteQuery(query);
	const pathValue = absolute ? suggestion.absolutePath : suggestion.path;
	const shouldQuote = quoted || needsQuotedMention(pathValue);
	return {
		insertText: shouldQuote
			? `@"${escapeQuotedPath(pathValue)}"`
			: `@${pathValue}`,
		pathValue,
		quoted: shouldQuote,
		absolute,
	};
}

function withInsertion<T extends Omit<FileMentionSuggestion, "insertText">>(
	query: string,
	suggestion: T & { insertText: string },
): FileMentionSuggestion {
	return {
		...suggestion,
		insertText: prepareFileMentionInsertion(query, suggestion).insertText,
	};
}

function normalizeEntry(
	index: FileMentionIndex,
	entry: FileMentionIndexEntry,
): FileMentionIndexEntry & { absolutePath: string } {
	const path = normalizePath(entry.path);
	return {
		...entry,
		path,
		absolutePath: entry.absolutePath
			? normalizePath(entry.absolutePath)
			: joinPath(index.projectRoot, path),
	};
}

function scoreFolder(
	entry: FileMentionIndexEntry & { absolutePath: string },
	query: string,
): number {
	const normalizedQuery = normalizeQuery(query).toLowerCase();
	const normalizedPath = matchPathForQuery(
		entry,
		normalizedQuery,
	).toLowerCase();
	const basename = pathBasename(entry.path).toLowerCase();
	const basenameScore = fuzzyScore(basename, normalizedQuery);
	const ancestorSegmentOnlyMatch = normalizedPath.startsWith(
		`${normalizedQuery}/`,
	);
	const pathScore = ancestorSegmentOnlyMatch
		? 0
		: fuzzyScore(normalizedPath, normalizedQuery);
	if (basenameScore === 0 && pathScore === 0) {
		return 0;
	}
	return Math.max(
		basenameScore > 0 ? basenameScore + BASENAME_MATCH_BONUS : 0,
		pathScore,
	);
}

function matchPathForQuery(
	entry: FileMentionIndexEntry & { absolutePath: string },
	normalizedQuery: string,
): string {
	return normalizedQuery.startsWith("/") ? entry.absolutePath : entry.path;
}

function fuzzyScore(value: string, query: string): number {
	if (!query) {
		return 0;
	}
	if (value === query) {
		return EXACT_MATCH_SCORE;
	}
	if (value.startsWith(query)) {
		return (
			PREFIX_MATCH_SCORE + PREFIX_MATCH_BONUS - (value.length - query.length)
		);
	}
	const contiguousIndex = value.indexOf(query);
	if (contiguousIndex >= 0) {
		return (
			CONTAINS_MATCH_SCORE +
			CONTIGUOUS_MATCH_BONUS -
			contiguousIndex -
			value.length
		);
	}

	let queryIndex = 0;
	let gaps = 0;
	let previousMatchIndex = -1;
	for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
		if (value[valueIndex] !== query[queryIndex]) {
			continue;
		}
		if (previousMatchIndex >= 0) {
			gaps += valueIndex - previousMatchIndex - 1;
		}
		previousMatchIndex = valueIndex;
		queryIndex += 1;
		if (queryIndex === query.length) {
			return Math.max(
				MINIMUM_FUZZY_SCORE,
				SUBSEQUENCE_MATCH_SCORE - gaps - value.length,
			);
		}
	}
	return 0;
}

function compareFolderMatches(
	a: { entry: { path: string }; score: number },
	b: { entry: { path: string }; score: number },
): number {
	return (
		b.score - a.score ||
		pathDepth(a.entry.path) - pathDepth(b.entry.path) ||
		a.entry.path.length - b.entry.path.length ||
		a.entry.path.localeCompare(b.entry.path)
	);
}

function compareExpandedFiles(
	a: { path: string },
	b: { path: string },
): number {
	return (
		pathDepth(a.path) - pathDepth(b.path) ||
		a.path.length - b.path.length ||
		a.path.localeCompare(b.path)
	);
}

function isDescendantPath(path: string, folderPath: string): boolean {
	return path.startsWith(`${folderPath}/`);
}

function normalizeQuery(query: string): string {
	return query
		.trim()
		.replace(/^@/, "")
		.replace(/^["']/, "")
		.replace(/["']$/, "")
		.replace(/^\.\//, "")
		.replace(/\\/g, "/");
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function joinPath(root: string, path: string): string {
	return `${normalizePath(root)}/${path}`.replace(/\/+/g, "/");
}

function pathBasename(path: string): string {
	return path.split("/").at(-1) ?? path;
}

function pathDepth(path: string): number {
	return path.split("/").length;
}

function isAbsoluteQuery(query: string): boolean {
	return normalizeQuery(query).startsWith("/");
}

function isQuotedQuery(query: string): boolean {
	const trimmed = query.trim().replace(/^@/, "");
	return trimmed.startsWith('"') || trimmed.startsWith("'");
}

function needsQuotedMention(path: string): boolean {
	return /\s|"|'/.test(path);
}

function escapeQuotedPath(path: string): string {
	return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
