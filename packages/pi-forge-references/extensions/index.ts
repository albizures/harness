import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

export type ForgeReadyRecord = {
	id: number;
	title: string;
	state: string;
	kind: string;
};

export type ForgeReadyRecordProvider = {
	getReadyRecords: (options?: {
		signal?: AbortSignal;
	}) => Promise<Array<ForgeReadyRecord> | undefined>;
};

type ForgeCommandResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
};

type ForgeCommandRunner = (
	command: string,
	args: Array<string>,
	options: { cwd: string; timeout: number; signal?: AbortSignal },
) => Promise<ForgeCommandResult>;

type ForgeReadyRecordProviderOptions = {
	runCommand?: ForgeCommandRunner;
	now?: () => number;
	cacheTtlMs?: number;
	notificationCooldownMs?: number;
	notify?: (message: string, type?: "info" | "warning" | "error") => void;
};

type ForgeReadyOutput = {
	records?: unknown;
};

type ForgeReferencesExtensionOptions = {
	createRecordProvider?: (options: {
		pi: ExtensionAPI;
		cwd: string;
		notify?: (message: string, type?: "info" | "warning" | "error") => void;
	}) => ForgeReadyRecordProvider;
} & Pick<
	ForgeReadyRecordProviderOptions,
	"cacheTtlMs" | "notificationCooldownMs" | "now" | "runCommand"
>;

const MAX_SUGGESTIONS = 20;
const DEFAULT_CACHE_TTL_MS = 2_000;
const DEFAULT_NOTIFICATION_COOLDOWN_MS = 30_000;
const FORGE_FAILURE_NOTIFICATION = "Forge References autocomplete failed.";

function isForgeReadyRecord(value: unknown): value is ForgeReadyRecord {
	if (!value || typeof value !== "object") {
		return false;
	}

	const record = value as Record<string, unknown>;
	return (
		typeof record.id === "number" &&
		typeof record.title === "string" &&
		typeof record.state === "string" &&
		record.state === "ready" &&
		typeof record.kind === "string"
	);
}

function parseForgeReadyRecords(
	stdout: string,
): Array<ForgeReadyRecord> | undefined {
	try {
		const parsed = JSON.parse(stdout) as ForgeReadyOutput;
		if (!Array.isArray(parsed.records)) {
			return undefined;
		}

		return parsed.records.filter(isForgeReadyRecord);
	} catch {
		return undefined;
	}
}

function isMarkdownHeadingStart(line: string, cursorCol: number): boolean {
	return /^\s{0,}#{1,6}$/.test(line.slice(0, cursorCol));
}

function extractForgeReferenceToken(
	textBeforeCursor: string,
): string | undefined {
	const match = textBeforeCursor.match(
		/(?:^|[^A-Za-z0-9._:-])#([A-Za-z0-9._:-]*)$/,
	);
	return match?.[1];
}

function formatRecordItem(record: ForgeReadyRecord): AutocompleteItem {
	return {
		value: `#${record.id}`,
		label: `#${record.id} ${record.kind} ${record.title}`,
	};
}

type RecordMatchGroup = "exact-id" | "id-prefix" | "id-substring" | "title";

function getRecordMatchGroup(
	record: ForgeReadyRecord,
	query: string,
): RecordMatchGroup | undefined {
	const normalizedQuery = query.toLowerCase();
	if (!normalizedQuery) {
		return "title";
	}

	const id = String(record.id).toLowerCase();
	const title = record.title.toLowerCase();
	if (id === normalizedQuery) {
		return "exact-id";
	}
	if (id.startsWith(normalizedQuery)) {
		return "id-prefix";
	}
	if (id.includes(normalizedQuery)) {
		return "id-substring";
	}
	if (title.includes(normalizedQuery)) {
		return "title";
	}
	return undefined;
}

function filterRecords(
	records: Array<ForgeReadyRecord>,
	query: string,
): Array<AutocompleteItem> {
	const groups: Record<RecordMatchGroup, Array<ForgeReadyRecord>> = {
		"exact-id": [],
		"id-prefix": [],
		"id-substring": [],
		title: [],
	};

	for (const record of records) {
		const group = getRecordMatchGroup(record, query);
		if (group) {
			groups[group].push(record);
		}
	}

	return [
		...groups["exact-id"],
		...groups["id-prefix"],
		...groups["id-substring"],
		...groups.title,
	]
		.slice(0, MAX_SUGGESTIONS)
		.map(formatRecordItem);
}

function applyForgeReferenceCompletion(
	lines: Array<string>,
	cursorLine: number,
	cursorCol: number,
	item: AutocompleteItem,
): { lines: Array<string>; cursorLine: number; cursorCol: number } | undefined {
	const currentLine = lines[cursorLine] ?? "";
	const beforeCursor = currentLine.slice(0, cursorCol);
	const match = beforeCursor.match(/(^|[^A-Za-z0-9._:-])#([A-Za-z0-9._:-]*)$/);
	if (!match || match.index === undefined) {
		return undefined;
	}

	const boundary = match[1] ?? "";
	const tokenStart = match.index + boundary.length;
	let tokenEnd = cursorCol;
	while (/[A-Za-z0-9._:-]/.test(currentLine[tokenEnd] ?? "")) {
		tokenEnd += 1;
	}

	const nextChar = currentLine[tokenEnd] ?? "";
	const needsTrailingSpace = nextChar === "" || !/\s/.test(nextChar);
	const replacement = `${item.value}${needsTrailingSpace ? " " : ""}`;
	const newLine = `${currentLine.slice(0, tokenStart)}${replacement}${currentLine.slice(tokenEnd)}`;
	const nextLines = [...lines];
	nextLines[cursorLine] = newLine;

	return {
		lines: nextLines,
		cursorLine,
		cursorCol: tokenStart + replacement.length,
	};
}

export function createForgeReadyRecordProvider(
	pi: ExtensionAPI,
	cwd: string,
	options: ForgeReadyRecordProviderOptions = {},
): ForgeReadyRecordProvider {
	const runCommand =
		options.runCommand ??
		((command, args, commandOptions) => pi.exec(command, args, commandOptions));
	const now = options.now ?? Date.now;
	const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
	const notificationCooldownMs =
		options.notificationCooldownMs ?? DEFAULT_NOTIFICATION_COOLDOWN_MS;
	let cache:
		| { expiresAt: number; records: Array<ForgeReadyRecord> | undefined }
		| undefined;
	let lastNotificationAt = Number.NEGATIVE_INFINITY;

	function notifyFailure() {
		const currentTime = now();
		if (currentTime - lastNotificationAt < notificationCooldownMs) {
			return;
		}

		lastNotificationAt = currentTime;
		options.notify?.(FORGE_FAILURE_NOTIFICATION, "error");
	}

	function cacheResult(records: Array<ForgeReadyRecord> | undefined) {
		cache = { expiresAt: now() + cacheTtlMs, records };
		return records;
	}

	return {
		getReadyRecords: async (requestOptions = {}) => {
			if (requestOptions.signal?.aborted) {
				return undefined;
			}

			const currentTime = now();
			if (cache && currentTime < cache.expiresAt) {
				return cache.records;
			}

			try {
				const result = await runCommand(
					process.env.FORGE_BIN || "forge",
					["ready", "--json"],
					{
						cwd,
						timeout: 5_000,
						signal: requestOptions.signal,
					},
				);

				if (requestOptions.signal?.aborted) {
					return undefined;
				}

				if (result.code !== 0) {
					notifyFailure();
					return cacheResult(undefined);
				}

				const records = parseForgeReadyRecords(result.stdout);
				if (!records) {
					notifyFailure();
				}
				return cacheResult(records);
			} catch {
				if (requestOptions.signal?.aborted) {
					return undefined;
				}

				notifyFailure();
				return cacheResult(undefined);
			}
		},
	};
}

export function createForgeReferencesAutocompleteProvider(
	current: AutocompleteProvider,
	recordProvider: ForgeReadyRecordProvider,
): AutocompleteProvider {
	return {
		triggerCharacters: Array.from(
			new Set([...(current.triggerCharacters ?? []), "#"]),
		),

		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const currentLine = lines[cursorLine] ?? "";
			if (isMarkdownHeadingStart(currentLine, cursorCol)) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const token = extractForgeReferenceToken(currentLine.slice(0, cursorCol));
			if (token === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const records = await recordProvider.getReadyRecords({
				signal: options.signal,
			});
			if (options.signal.aborted || !records || records.length === 0) {
				return null;
			}

			const items = filterRecords(records, token);
			if (items.length === 0) {
				return null;
			}

			return {
				items,
				prefix: `#${token}`,
			};
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (prefix.startsWith("#")) {
				const applied = applyForgeReferenceCompletion(
					lines,
					cursorLine,
					cursorCol,
					item,
				);
				if (applied) {
					return applied;
				}
			}

			return current.applyCompletion(
				lines,
				cursorLine,
				cursorCol,
				item,
				prefix,
			);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return (
				current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
				true
			);
		},
	};
}

export function registerForgeReferencesExtension(
	pi: ExtensionAPI,
	options: ForgeReferencesExtensionOptions = {},
) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") {
			return;
		}

		const notify = ctx.ui.notify?.bind(ctx.ui);
		const recordProvider =
			options.createRecordProvider?.({ pi, cwd: ctx.cwd, notify }) ??
			createForgeReadyRecordProvider(pi, ctx.cwd, {
				cacheTtlMs: options.cacheTtlMs,
				notificationCooldownMs: options.notificationCooldownMs,
				now: options.now,
				runCommand: options.runCommand,
				notify,
			});

		ctx.ui.addAutocompleteProvider((current) =>
			createForgeReferencesAutocompleteProvider(current, recordProvider),
		);
	});
}

// biome-ignore lint/style/noDefaultExport: Pi extension modules are loaded through default exports.
export default function forgeReferences(pi: ExtensionAPI) {
	registerForgeReferencesExtension(pi);
}
