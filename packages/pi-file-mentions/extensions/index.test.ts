// biome-ignore-all lint/suspicious/noExplicitAny: Tests use focused fakes for the Pi extension API.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { registerFileMentionsExtension } from "./index.ts";
import type { FileMentionIndexProvider } from "./indexer.ts";

function createPiFake() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	return {
		pi: {
			on: (event: string, handler: any) => {
				handlers.set(event, handler);
			},
			registerCommand: (name: string, options: any) => {
				commands.set(name, options);
			},
		},
		commands,
		handlers,
	};
}

function createProvider(indexLabel: string): FileMentionIndexProvider & {
	refreshCount: number;
} {
	return {
		refreshCount: 0,
		getIndex: async () => ({ projectRoot: indexLabel, entries: [] }),
		refresh: async function () {
			this.refreshCount += 1;
			return { projectRoot: indexLabel, entries: [] };
		},
		clear: () => {},
	};
}

test("when the refresh command runs, it rebuilds only the current cwd File Mention Index", async () => {
	const firstCwd = path.resolve("/repo/first");
	const secondCwd = path.resolve("/repo/second");
	const providers = new Map<string, ReturnType<typeof createProvider>>();
	const { pi, commands, handlers } = createPiFake();

	registerFileMentionsExtension(pi as any, {
		createIndexProvider: ({ cwd }) => {
			const provider = createProvider(cwd ?? "");
			providers.set(path.resolve(cwd ?? ""), provider);
			return provider;
		},
	});

	await handlers.get("session_start")(
		{},
		{ cwd: firstCwd, ui: { addAutocompleteProvider: () => {} } },
	);
	await handlers.get("session_start")(
		{},
		{ cwd: secondCwd, ui: { addAutocompleteProvider: () => {} } },
	);

	const notifications: Array<{ message: string; type?: string }> = [];
	await commands.get("file-mentions-refresh").handler("", {
		cwd: secondCwd,
		hasUI: true,
		ui: {
			notify: (message: string, type?: string) =>
				notifications.push({ message, type }),
		},
	});

	assert.equal(providers.get(firstCwd)?.refreshCount, 0);
	assert.equal(providers.get(secondCwd)?.refreshCount, 1);
	assert.deepEqual(notifications, [
		{ message: "File Mentions refreshed.", type: "info" },
	]);
});

test("when the refresh command receives arguments, it rejects them without rebuilding", async () => {
	const cwd = path.resolve("/repo");
	const provider = createProvider(cwd);
	const { pi, commands } = createPiFake();
	registerFileMentionsExtension(pi as any, {
		createIndexProvider: () => provider,
	});

	const notifications: Array<{ message: string; type?: string }> = [];
	await commands.get("file-mentions-refresh").handler("src", {
		cwd,
		hasUI: true,
		ui: {
			notify: (message: string, type?: string) =>
				notifications.push({ message, type }),
		},
	});

	assert.equal(provider.refreshCount, 0);
	assert.deepEqual(notifications, [
		{
			message:
				"Usage: /file-mentions-refresh (path arguments are not supported).",
			type: "warning",
		},
	]);
});

test("when the refresh command cannot rebuild the File Mention Index, it reports failure", async () => {
	const cwd = path.resolve("/repo");
	const { pi, commands } = createPiFake();
	registerFileMentionsExtension(pi as any, {
		createIndexProvider: () => ({
			getIndex: async () => null,
			refresh: async () => null,
			clear: () => {},
		}),
	});

	const notifications: Array<{ message: string; type?: string }> = [];
	await commands.get("file-mentions-refresh").handler("", {
		cwd,
		hasUI: true,
		ui: {
			notify: (message: string, type?: string) =>
				notifications.push({ message, type }),
		},
	});

	assert.deepEqual(notifications, [
		{ message: "File Mentions refresh failed.", type: "error" },
	]);
});
