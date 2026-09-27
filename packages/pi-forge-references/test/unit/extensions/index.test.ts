// biome-ignore-all lint/suspicious/noExplicitAny: Tests use focused fakes for the Pi extension API.
import { describe, expect, it } from "vitest";
import {
	createForgeReadyRecordProvider,
	createForgeReferencesAutocompleteProvider,
	registerForgeReferencesExtension,
	type AutocompleteProvider,
	type ForgeReadyRecord,
} from "../../../extensions/index.ts";

function createNativeProvider(): AutocompleteProvider & {
	calls: number;
	applyCalls: number;
} {
	return {
		triggerCharacters: ["/"],
		calls: 0,
		applyCalls: 0,
		getSuggestions: async function () {
			this.calls += 1;
			return null;
		},
		applyCompletion: function (lines, cursorLine, cursorCol) {
			this.applyCalls += 1;
			return {
				lines,
				cursorLine,
				cursorCol,
			};
		},
	};
}

const AUDIT_TASK_ID = 35;
const PACKAGE_TASK_ID = 43;
const FORGE_RECORD_REFERENCE_CURSOR_COL = 15;
const REGISTERED_PROVIDER_REFERENCE_CURSOR_COL = 7;
const INLINE_TOKEN_CURSOR_COL = 9;
const MARKDOWN_HEADING_CURSOR_COL = 5;
const ALPHA_TASK_ID = 12;
const FIRST_TITLE_MATCH_TASK_ID = 41;
const SECOND_TITLE_MATCH_TASK_ID = 43;
const ALPHA_FOLLOW_UP_TASK_ID = 51;
const APPLY_REFERENCE_CURSOR_COL = 16;
const CACHE_START_MS = 1_000;
const CACHE_HIT_MS = 2_999;
const NOTIFICATION_COOLDOWN_HIT_MS = 30_999;
const NOTIFICATION_COOLDOWN_EXPIRED_MS = 31_000;
const SHORT_CACHE_TTL_MS = 2_000;
const NOTIFICATION_COOLDOWN_MS = 30_000;

function createRecord(
	id: number,
	title: string,
	kind = "task",
): ForgeReadyRecord {
	return { id, title, state: "ready", kind };
}

describe("Forge References autocomplete", () => {
	it("should suggest ready Forge record references when the prompt token starts with #", async () => {
		const native = createNativeProvider();
		const provider = createForgeReferencesAutocompleteProvider(native, {
			getReadyRecords: async () => [
				createRecord(
					AUDIT_TASK_ID,
					"Audit Forge effectful seams before migration",
					"spec",
				),
				createRecord(
					PACKAGE_TASK_ID,
					"Create Pi Forge References package skeleton",
					"wayfinder",
				),
			],
		});

		const suggestions = await provider.getSuggestions(
			["forge record #4"],
			0,
			FORGE_RECORD_REFERENCE_CURSOR_COL,
			{ signal: new AbortController().signal },
		);

		expect(suggestions).toEqual({
			prefix: "#4",
			items: [
				{
					value: "#43",
					label: "#43 wayfinder Create Pi Forge References package skeleton",
				},
			],
		});
		expect(native.calls).toBe(0);
	});

	it("should preserve existing trigger characters and add the Forge reference trigger", () => {
		const native = createNativeProvider();
		const provider = createForgeReferencesAutocompleteProvider(native, {
			getReadyRecords: async () => [],
		});

		expect(provider.triggerCharacters).toEqual(["/", "#"]);
	});

	it("should fall back to the existing provider outside a Forge reference token", async () => {
		const native = createNativeProvider();
		const provider = createForgeReferencesAutocompleteProvider(native, {
			getReadyRecords: async () => [
				createRecord(PACKAGE_TASK_ID, "Create package skeleton"),
			],
		});

		await provider.getSuggestions(["not#token"], 0, INLINE_TOKEN_CURSOR_COL, {
			signal: new AbortController().signal,
		});

		expect(native.calls).toBe(1);
	});

	it("should suppress Markdown heading starts", async () => {
		const native = createNativeProvider();
		const provider = createForgeReferencesAutocompleteProvider(native, {
			getReadyRecords: async () => [createRecord(PACKAGE_TASK_ID, "Record")],
		});

		await provider.getSuggestions(["  ###"], 0, MARKDOWN_HEADING_CURSOR_COL, {
			signal: new AbortController().signal,
		});

		expect(native.calls).toBe(1);
	});

	it("should sort id prefix matches before title matches while preserving Forge order", async () => {
		const native = createNativeProvider();
		const provider = createForgeReferencesAutocompleteProvider(native, {
			getReadyRecords: async () => [
				createRecord(ALPHA_TASK_ID, "Alpha work"),
				createRecord(FIRST_TITLE_MATCH_TASK_ID, "First title match"),
				createRecord(SECOND_TITLE_MATCH_TASK_ID, "Second title match"),
				createRecord(ALPHA_FOLLOW_UP_TASK_ID, "Alpha follow-up"),
			],
		});

		const suggestions = await provider.getSuggestions(["#4"], 0, 2, {
			signal: new AbortController().signal,
		});

		expect(suggestions?.items.map((item) => item.value)).toEqual([
			"#41",
			"#43",
		]);
	});

	it("should replace only the active Forge reference token when applying a suggestion", () => {
		const native = createNativeProvider();
		const provider = createForgeReferencesAutocompleteProvider(native, {
			getReadyRecords: async () => [],
		});

		const applied = provider.applyCompletion(
			["please handle #4 then"],
			0,
			APPLY_REFERENCE_CURSOR_COL,
			{ value: "#43", label: "#43 task Record" },
			"#4",
		);

		expect(applied).toEqual({
			lines: ["please handle #43 then"],
			cursorLine: 0,
			cursorCol: 17,
		});
		expect(native.applyCalls).toBe(0);
	});
});

describe("createForgeReadyRecordProvider", () => {
	it("should shell out to FORGE_BIN with ready --json using the session cwd", async () => {
		const previousForgeBin = process.env.FORGE_BIN;
		process.env.FORGE_BIN = "/custom/forge";
		const execCalls: Array<any> = [];
		const pi = {
			exec: async (...args: Array<any>) => {
				execCalls.push(args);
				return { code: 0, stdout: '{"records":[]}', stderr: "", killed: false };
			},
		};

		try {
			const provider = createForgeReadyRecordProvider(pi as any, "/repo");
			await provider.getReadyRecords();
		} finally {
			process.env.FORGE_BIN = previousForgeBin;
		}

		expect(execCalls).toEqual([
			[
				"/custom/forge",
				["ready", "--json"],
				{ cwd: "/repo", timeout: 5_000, signal: undefined },
			],
		]);
	});

	it("should fall back to forge when FORGE_BIN is empty", async () => {
		const previousForgeBin = process.env.FORGE_BIN;
		process.env.FORGE_BIN = "";
		const execCalls: Array<any> = [];
		const pi = {
			exec: async (...args: Array<any>) => {
				execCalls.push(args);
				return { code: 0, stdout: '{"records":[]}', stderr: "", killed: false };
			},
		};

		try {
			const provider = createForgeReadyRecordProvider(pi as any, "/repo");
			await provider.getReadyRecords();
		} finally {
			process.env.FORGE_BIN = previousForgeBin;
		}

		expect(execCalls[0][0]).toBe("forge");
	});

	it("should return every ready record kind from Forge JSON", async () => {
		const provider = createForgeReadyRecordProvider({} as any, "/repo", {
			runCommand: async () => ({
				code: 0,
				stdout: JSON.stringify({
					records: [
						{ id: 1, kind: "spec", state: "ready", title: "Define workflow" },
						{
							id: 2,
							kind: "task",
							state: "ready",
							title: "Implement workflow",
						},
						{
							id: 3,
							kind: "grilling",
							state: "ready",
							title: "Clarify workflow",
						},
						{ id: 4, kind: "task", state: "done", title: "Finished workflow" },
					],
				}),
				stderr: "",
				killed: false,
			}),
		});

		expect(await provider.getReadyRecords()).toEqual([
			{ id: 1, kind: "spec", state: "ready", title: "Define workflow" },
			{ id: 2, kind: "task", state: "ready", title: "Implement workflow" },
			{ id: 3, kind: "grilling", state: "ready", title: "Clarify workflow" },
		]);
	});

	it("should cache successful empty ready sets for the configured TTL", async () => {
		let now = CACHE_START_MS;
		let calls = 0;
		const provider = createForgeReadyRecordProvider({} as any, "/repo", {
			now: () => now,
			cacheTtlMs: SHORT_CACHE_TTL_MS,
			runCommand: async () => {
				calls += 1;
				return { code: 0, stdout: '{"records":[]}', stderr: "", killed: false };
			},
		});

		expect(await provider.getReadyRecords()).toEqual([]);
		now = CACHE_HIT_MS;
		expect(await provider.getReadyRecords()).toEqual([]);

		expect(calls).toBe(1);
	});

	it("should cache missing or failed Forge command results for the configured TTL", async () => {
		let now = CACHE_START_MS;
		let calls = 0;
		const notifications: Array<{ message: string; type?: string }> = [];
		const provider = createForgeReadyRecordProvider({} as any, "/repo", {
			now: () => now,
			cacheTtlMs: SHORT_CACHE_TTL_MS,
			notify: (message, type) => notifications.push({ message, type }),
			runCommand: async () => {
				calls += 1;
				throw new Error("ENOENT");
			},
		});

		expect(await provider.getReadyRecords()).toBeUndefined();
		now = CACHE_HIT_MS;
		expect(await provider.getReadyRecords()).toBeUndefined();

		expect(calls).toBe(1);
		expect(notifications).toEqual([
			{ message: "Forge References autocomplete failed.", type: "error" },
		]);
	});

	it("should rate-limit failure notifications by the configured cooldown", async () => {
		let now = CACHE_START_MS;
		const notifications: Array<{ message: string; type?: string }> = [];
		const provider = createForgeReadyRecordProvider({} as any, "/repo", {
			now: () => now,
			cacheTtlMs: 0,
			notificationCooldownMs: NOTIFICATION_COOLDOWN_MS,
			notify: (message, type) => notifications.push({ message, type }),
			runCommand: async () => ({
				code: 2,
				stdout: "",
				stderr: "failed",
				killed: false,
			}),
		});

		await provider.getReadyRecords();
		now = NOTIFICATION_COOLDOWN_HIT_MS;
		await provider.getReadyRecords();
		now = NOTIFICATION_COOLDOWN_EXPIRED_MS;
		await provider.getReadyRecords();

		expect(notifications).toEqual([
			{ message: "Forge References autocomplete failed.", type: "error" },
			{ message: "Forge References autocomplete failed.", type: "error" },
		]);
	});

	it("should treat invalid Forge JSON as a cached failure", async () => {
		let calls = 0;
		const provider = createForgeReadyRecordProvider({} as any, "/repo", {
			runCommand: async () => {
				calls += 1;
				return { code: 0, stdout: "not-json", stderr: "", killed: false };
			},
		});

		expect(await provider.getReadyRecords()).toBeUndefined();
		expect(await provider.getReadyRecords()).toBeUndefined();

		expect(calls).toBe(1);
	});

	it("should pass abort signals to the command runner and suppress abort notifications", async () => {
		const controller = new AbortController();
		const notifications: Array<{ message: string; type?: string }> = [];
		let receivedSignal: AbortSignal | undefined;
		const provider = createForgeReadyRecordProvider({} as any, "/repo", {
			notify: (message, type) => notifications.push({ message, type }),
			runCommand: async (_command, _args, options) => {
				receivedSignal = options.signal;
				controller.abort();
				return { code: 1, stdout: "", stderr: "aborted", killed: true };
			},
		});

		expect(
			await provider.getReadyRecords({ signal: controller.signal }),
		).toBeUndefined();

		expect(receivedSignal).toBe(controller.signal);
		expect(notifications).toEqual([]);
	});
});

describe("registerForgeReferencesExtension", () => {
	it("should register an autocomplete provider for session start without querying Forge", () => {
		const handlers = new Map<string, any>();
		const autocompleteProviders: Array<any> = [];
		let readyRecordCalls = 0;
		const recordProvider = {
			getReadyRecords: async () => {
				readyRecordCalls += 1;
				return [];
			},
		};
		const pi = {
			on: (event: string, handler: any) => handlers.set(event, handler),
		};

		registerForgeReferencesExtension(pi as any, {
			createRecordProvider: () => recordProvider,
		});
		handlers.get("session_start")(
			{},
			{
				cwd: "/repo",
				mode: "tui",
				ui: {
					addAutocompleteProvider: (provider: any) =>
						autocompleteProviders.push(provider),
				},
			},
		);

		expect(autocompleteProviders).toHaveLength(1);
		expect(readyRecordCalls).toBe(0);
	});

	it("should query Forge only after registered autocomplete receives an active reference token", async () => {
		const handlers = new Map<string, any>();
		const autocompleteProviderFactories: Array<
			(current: AutocompleteProvider) => AutocompleteProvider
		> = [];
		let readyRecordCalls = 0;
		const recordProvider = {
			getReadyRecords: async () => {
				readyRecordCalls += 1;
				return [createRecord(PACKAGE_TASK_ID, "Create package skeleton")];
			},
		};
		const pi = {
			on: (event: string, handler: any) => handlers.set(event, handler),
		};

		registerForgeReferencesExtension(pi as any, {
			createRecordProvider: () => recordProvider,
		});
		handlers.get("session_start")(
			{},
			{
				cwd: "/repo",
				mode: "tui",
				ui: {
					addAutocompleteProvider: (provider: any) =>
						autocompleteProviderFactories.push(provider),
				},
			},
		);

		const provider = autocompleteProviderFactories[0](createNativeProvider());

		expect(readyRecordCalls).toBe(0);
		expect(
			await provider.getSuggestions(
				["task #4"],
				0,
				REGISTERED_PROVIDER_REFERENCE_CURSOR_COL,
				{
					signal: new AbortController().signal,
				},
			),
		).toEqual({
			prefix: "#4",
			items: [{ value: "#43", label: "#43 task Create package skeleton" }],
		});
		expect(readyRecordCalls).toBe(1);
	});

	it("should not register an autocomplete provider outside TUI mode", () => {
		const handlers = new Map<string, any>();
		const autocompleteProviders: Array<any> = [];
		const recordProvider = { getReadyRecords: async () => [] };
		const pi = {
			on: (event: string, handler: any) => handlers.set(event, handler),
		};

		registerForgeReferencesExtension(pi as any, {
			createRecordProvider: () => recordProvider,
		});
		handlers.get("session_start")(
			{},
			{
				cwd: "/repo",
				mode: "headless",
				ui: {
					addAutocompleteProvider: (provider: any) =>
						autocompleteProviders.push(provider),
				},
			},
		);

		expect(autocompleteProviders).toHaveLength(0);
	});
});
