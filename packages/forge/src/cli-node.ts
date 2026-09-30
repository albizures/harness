import { realpathSync } from "node:fs";
import process from "node:process";
import { text as readStreamText } from "node:stream/consumers";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Effect } from "effect";

export type ExitCodeTarget = { exitCode?: string | number | null | undefined };
export type WritableTarget = Pick<NodeJS.WriteStream, "write">;

export function defaultArgv(): ReadonlyArray<string> {
	return process.argv.slice(2);
}

export function defaultExitCodeTarget(): ExitCodeTarget {
	return process;
}

export function defaultStdout(): WritableTarget {
	return process.stdout;
}

export function defaultStderr(): WritableTarget {
	return process.stderr;
}

export function defaultEnv(): NodeJS.ProcessEnv {
	return process.env;
}

export function defaultCwd(): string {
	return process.cwd();
}

export function defaultHomeDirectory(
	env: NodeJS.ProcessEnv,
): string | undefined {
	return env.FORGE_HOME ?? env.HOME ?? process.env.HOME;
}

export function fallbackEditor(env: NodeJS.ProcessEnv): string | undefined {
	return env.EDITOR ?? process.env.EDITOR;
}

export function uniqueNodeProcessSuffix(now = Date.now()): string {
	return `${process.pid}-${now}`;
}

export function defaultStdin(): NodeJS.ReadableStream {
	return process.stdin;
}

export function readNodeStreamTextEffect(
	stream: NodeJS.ReadableStream,
): Effect.Effect<string, unknown> {
	return Effect.promise(() => readStreamText(stream));
}

export function defaultArgv1(): string | undefined {
	return process.argv[1];
}

export function isNodeCliEntrypoint(
	metaUrl: string,
	argv1 = defaultArgv1(),
): boolean {
	if (argv1 === undefined) {
		return false;
	}

	try {
		return (
			pathToFileURL(realpathSync(fileURLToPath(metaUrl))).href ===
			pathToFileURL(realpathSync(argv1)).href
		);
	} catch {
		return metaUrl === pathToFileURL(argv1).href;
	}
}
