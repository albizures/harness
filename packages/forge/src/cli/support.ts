import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import type { FileSystem } from "@effect/platform/FileSystem";
import { Context, Effect } from "effect";
import type {
	CliAction,
	CliInvocationContext,
	CommandOutput,
	FlagValue,
	Parsed,
} from "./types.ts";

export type CliRuntimeContext = {
	readonly invocationContext: CliInvocationContext;
	readonly setOutput: (output: CommandOutput) => void;
};

export const CliRuntimeContext = Context.GenericTag<CliRuntimeContext>(
	"@albizures/forge/CliRuntimeContext",
);

type NativeParsedConfig = Readonly<Record<string, unknown>>;

export function parsedFromCommandConfig(
	path: ReadonlyArray<string>,
	config: unknown,
	rootConfig: unknown,
	baseContext: CliInvocationContext,
	positionals: ReadonlyArray<string>,
): Parsed {
	const root = asNativeConfig(rootConfig);
	const leaf = asNativeConfig(config);
	const flags = {
		...collectDirectNativeFlags(root),
		...collectDirectNativeFlags(leaf),
	};
	return {
		...baseContext,
		presentation: flags.json === true ? "json" : baseContext.presentation,
		cwd: optionalString(root.cwd) ?? baseContext.cwd,
		storeOverride: optionalString(root.store) ?? baseContext.storeOverride,
		positionals: [
			...path,
			...positionals
				.map((key) => optionalString(leaf[key]))
				.filter((value): value is string => value !== undefined),
		],
		flags,
	};
}

function collectDirectNativeFlags(
	config: NativeParsedConfig,
): Record<string, FlagValue> {
	const flags: Record<string, FlagValue> = {};
	for (const [key, value] of Object.entries(config)) {
		if (key === "subcommand") {
			continue;
		}
		const flagValue = nativeFlagValue(value);
		if (flagValue !== undefined) {
			flags[nativeFlagName(key)] = flagValue;
		}
	}
	return flags;
}

function asNativeConfig(value: unknown): NativeParsedConfig {
	return typeof value === "object" && value !== null
		? (value as NativeParsedConfig)
		: {};
}

function nativeFlagValue(value: unknown): FlagValue | undefined {
	const unwrapped = unwrapNativeOption(value);
	if (unwrapped === undefined || unwrapped === false) {
		return undefined;
	}
	if (Array.isArray(unwrapped)) {
		return unwrapped.map(String);
	}
	if (typeof unwrapped === "boolean") {
		return unwrapped;
	}
	return String(unwrapped);
}

function unwrapNativeOption(value: unknown): unknown {
	const option = value as { readonly _tag?: string; readonly value?: unknown };
	if (option?._tag === "None") {
		return undefined;
	}
	if (option?._tag === "Some") {
		return option.value;
	}
	return value;
}

function optionalString(value: unknown): string | undefined {
	const unwrapped = unwrapNativeOption(value);
	return unwrapped === undefined ? undefined : String(unwrapped);
}

function nativeFlagName(key: string): string {
	return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export function commandHandler(
	path: ReadonlyArray<string>,
	action: CliAction,
	positionals: ReadonlyArray<string> = [],
	formatHuman: (value: unknown) => string = (value) => JSON.stringify(value),
): <A>(
	config: A,
) => Effect.Effect<
	void,
	unknown,
	CommandExecutor | FileSystem | CliRuntimeContext
> {
	return <A>(config: A) =>
		Effect.gen(function* () {
			const runtime = yield* CliRuntimeContext;
			const parsed = parsedFromCommandConfig(
				path,
				config,
				{},
				runtime.invocationContext,
				positionals,
			);
			const output = yield* action(parsed);
			runtime.setOutput(output);
			renderOutput(parsed, output, formatHuman);
		});
}

export function present(
	value: unknown,
	code = 0,
	human?: string,
): CommandOutput {
	return { value, code, human };
}

export function renderOutput(
	parsed: Pick<CliInvocationContext, "presentation" | "stdout">,
	output: CommandOutput,
	formatHuman: (value: unknown) => string,
): void {
	if (output.value === undefined && output.human === undefined) {
		return;
	}
	if (parsed.presentation === "json") {
		writeOut(parsed.stdout, `${JSON.stringify(output.value, null, "\t")}\n`);
		return;
	}
	writeOut(parsed.stdout, `${output.human ?? formatHuman(output.value)}\n`);
}

function writeOut(
	stream: Pick<NodeJS.WriteStream, "write">,
	value: string,
): void {
	stream.write(value);
}
