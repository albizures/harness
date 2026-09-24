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

export type ForgeReadyTask = {
	id: number;
	title: string;
	state: string;
	kind: string;
};

export type ForgeReadyTaskProvider = {
	getReadyTasks: (options?: {
		signal?: AbortSignal;
	}) => Promise<Array<ForgeReadyTask> | undefined>;
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

type ForgeReadyTaskProviderOptions = {
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
	createTaskProvider?: (options: {
		pi: ExtensionAPI;
		cwd: string;
		notify?: (message: string, type?: "info" | "warning" | "error") => void;
	}) => ForgeReadyTaskProvider;
} & Pick<
	ForgeReadyTaskProviderOptions,
	"cacheTtlMs" | "notificationCooldownMs" | "now" | "runCommand"
>;

const MAX_SUGGESTIONS = 20;
const DEFAULT_CACHE_TTL_MS = 2_000;
const DEFAULT_NOTIFICATION_COOLDOWN_MS = 30_000;
const FORGE_FAILURE_NOTIFICATION = "Forge References autocomplete failed.";

function isForgeReadyTask(value: unknown): value is ForgeReadyTask {
	if (!value || typeof value !== "object") {
		return false;
	}

	const record = value as Record<string, unknown>;
	return (
		typeof record.id === "number" &&
		typeof record.title === "string" &&
		typeof record.state === "string" &&
		record.state === "ready" &&
		record.kind === "task"
	);
}

function parseForgeReadyTasks(
	stdout: string,
): Array<ForgeReadyTask> | undefined {
	try {
		const parsed = JSON.parse(stdout) as ForgeReadyOutput;
		if (!Array.isArray(parsed.records)) {
			return undefined;
		}

		return parsed.records.filter(isForgeReadyTask);
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

function formatTaskItem(task: ForgeReadyTask): AutocompleteItem {
	return {
		value: `#${task.id}`,
		label: `#${task.id} ${task.title}`,
	};
}

type TaskMatchGroup = "exact-id" | "id-prefix" | "id-substring" | "title";

function getTaskMatchGroup(
	task: ForgeReadyTask,
	query: string,
): TaskMatchGroup | undefined {
	const normalizedQuery = query.toLowerCase();
	if (!normalizedQuery) {
		return "title";
	}

	const id = String(task.id).toLowerCase();
	const title = task.title.toLowerCase();
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

function filterTasks(
	tasks: Array<ForgeReadyTask>,
	query: string,
): Array<AutocompleteItem> {
	const groups: Record<TaskMatchGroup, Array<ForgeReadyTask>> = {
		"exact-id": [],
		"id-prefix": [],
		"id-substring": [],
		title: [],
	};

	for (const task of tasks) {
		const group = getTaskMatchGroup(task, query);
		if (group) {
			groups[group].push(task);
		}
	}

	return [
		...groups["exact-id"],
		...groups["id-prefix"],
		...groups["id-substring"],
		...groups.title,
	]
		.slice(0, MAX_SUGGESTIONS)
		.map(formatTaskItem);
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

export function createForgeReadyTaskProvider(
	pi: ExtensionAPI,
	cwd: string,
	options: ForgeReadyTaskProviderOptions = {},
): ForgeReadyTaskProvider {
	const runCommand =
		options.runCommand ??
		((command, args, commandOptions) => pi.exec(command, args, commandOptions));
	const now = options.now ?? Date.now;
	const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
	const notificationCooldownMs =
		options.notificationCooldownMs ?? DEFAULT_NOTIFICATION_COOLDOWN_MS;
	let cache:
		| { expiresAt: number; tasks: Array<ForgeReadyTask> | undefined }
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

	function cacheResult(tasks: Array<ForgeReadyTask> | undefined) {
		cache = { expiresAt: now() + cacheTtlMs, tasks };
		return tasks;
	}

	return {
		getReadyTasks: async (requestOptions = {}) => {
			if (requestOptions.signal?.aborted) {
				return undefined;
			}

			const currentTime = now();
			if (cache && currentTime < cache.expiresAt) {
				return cache.tasks;
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

				const tasks = parseForgeReadyTasks(result.stdout);
				if (!tasks) {
					notifyFailure();
				}
				return cacheResult(tasks);
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
	taskProvider: ForgeReadyTaskProvider,
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const currentLine = lines[cursorLine] ?? "";
			if (isMarkdownHeadingStart(currentLine, cursorCol)) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const token = extractForgeReferenceToken(currentLine.slice(0, cursorCol));
			if (token === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const tasks = await taskProvider.getReadyTasks({
				signal: options.signal,
			});
			if (options.signal.aborted || !tasks || tasks.length === 0) {
				return null;
			}

			const items = filterTasks(tasks, token);
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
		const taskProvider =
			options.createTaskProvider?.({ pi, cwd: ctx.cwd, notify }) ??
			createForgeReadyTaskProvider(pi, ctx.cwd, {
				cacheTtlMs: options.cacheTtlMs,
				notificationCooldownMs: options.notificationCooldownMs,
				now: options.now,
				runCommand: options.runCommand,
				notify,
			});

		void taskProvider.getReadyTasks();
		ctx.ui.addAutocompleteProvider((current) =>
			createForgeReferencesAutocompleteProvider(current, taskProvider),
		);
	});
}

// biome-ignore lint/style/noDefaultExport: Pi extension modules are loaded through default exports.
export default function forgeReferences(pi: ExtensionAPI) {
	registerForgeReferencesExtension(pi);
}
