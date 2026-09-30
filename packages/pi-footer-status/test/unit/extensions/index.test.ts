// biome-ignore-all lint/style/noMagicNumbers: Test literals describe expected rendering behavior.
// biome-ignore-all lint/suspicious/noExplicitAny: Tests use partial extension API fixtures.
import { expect, test } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	renderContextFillBar,
	renderFooter,
} from "../../../extensions/index.ts";

const identityTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const taggedTheme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
};

function assistantEntry(usage: Partial<any>) {
	return {
		type: "message",
		message: {
			role: "assistant",
			usage: {
				input: 1200,
				output: 345,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0 },
				...usage,
			},
		},
	} as any;
}

function baseState(overrides: Record<string, unknown> = {}) {
	return {
		cwd: "/home/alice/work/repo",
		home: "/home/alice",
		sessionName: "named-session",
		gitBranch: "main",
		extensionStatuses: new Map<string, string>(),
		availableProviderCount: 1,
		model: {
			id: "gpt-test",
			provider: "openai",
			contextWindow: 128000,
			reasoning: true,
		},
		thinkingLevel: "medium",
		contextUsage: { tokens: 51200, contextWindow: 128000, percent: 40 },
		entries: [
			assistantEntry({
				cacheRead: 100,
				cacheWrite: 50,
				cost: { total: 0.0123 },
			}),
		],
		...overrides,
	} as any;
}

test("renderFooter preserves default-like footer lines and inserts the Context fill bar before sorted extension statuses", () => {
	const lines = renderFooter(
		baseState({
			extensionStatuses: new Map([
				["z-last", "second"],
				["a-first", "first"],
			]),
		}),
		identityTheme,
		120,
	);

	expect(lines.length).toBe(4);
	expect(lines[0]).toBe("~/work/repo (main) • named-session");
	expect(lines[1]).toMatch(
		/↑1\.2k ↓345 R100 W50 CH7\.4% \$0\.012 40\.0%\/128k \(auto\)\s+gpt-test • medium/,
	);
	expect(lines[2]).toBe("context ████████░░░░░░░░░░░░ 40.0%/128k");
	expect(lines[3]).toBe("first second");
});

test("renderContextFillBar uses fixed 20-cell known-usage bars with required rounding behavior", () => {
	const cases = [
		{ percent: 0, expected: "░░░░░░░░░░░░░░░░░░░░ 0.0%/100k" },
		{ percent: 1, expected: "█░░░░░░░░░░░░░░░░░░░ 1.0%/100k" },
		{ percent: 40, expected: "████████░░░░░░░░░░░░ 40.0%/100k" },
		{ percent: 99.6, expected: "████████████████████ 99.6%/100k" },
	];

	for (const { percent, expected } of cases) {
		expect(
			renderContextFillBar(
				{ percent, contextWindow: 100000 },
				identityTheme,
				120,
			),
		).toBe(`context ${expected}`);
	}
});

test("renderContextFillBar applies severity colors at the same thresholds as Pi context text", () => {
	const normal = renderContextFillBar(
		{ percent: 40, contextWindow: 100000 },
		taggedTheme,
		200,
	);
	expect(normal).toMatch(/<accent>█/);
	expect(normal).toMatch(/<dim>░/);
	expect(normal).toMatch(/<accent>40\.0%\/100k<\/accent>/);

	const warning = renderContextFillBar(
		{ percent: 70.1, contextWindow: 100000 },
		taggedTheme,
		200,
	);
	expect(warning).toMatch(/<warning>█/);
	expect(warning).toMatch(/<dim>░/);
	expect(warning).toMatch(/<warning>70\.1%\/100k<\/warning>/);

	expect(
		renderContextFillBar(
			{ percent: 90.1, contextWindow: 100000 },
			taggedTheme,
			200,
		),
	).toMatch(/<error>█/);
	expect(
		renderContextFillBar(
			{ percent: 90.1, contextWindow: 100000 },
			taggedTheme,
			200,
		),
	).toMatch(/<error>90\.1%\/100k<\/error>/);
});

test("renderContextFillBar renders unknown usage as a static dim placeholder with ? percentage", () => {
	const line = renderContextFillBar(
		{ percent: null, contextWindow: 200000 },
		identityTheme,
		120,
	);

	expect(line).toBe("context ░░░░░░░░░░░░░░░░░░░░ ?/200k");

	const styledLine = renderContextFillBar(
		{ percent: undefined, contextWindow: 200000 },
		taggedTheme,
		200,
	);
	expect(styledLine).toMatch(/<dim>░░░░░░░░░░░░░░░░░░░░<\/dim>/);
	expect(styledLine).toMatch(/\?\/200k/);
	expect(styledLine).not.toMatch(/<accent>|<warning>|<error>/);
});

test("renderFooter renders unknown Context fill bar line without auto-compaction text", () => {
	const lines = renderFooter(
		baseState({
			contextUsage: { tokens: 0, contextWindow: 128000, percent: null },
		}),
		identityTheme,
		120,
	);

	expect(lines[2]).toBe("context ░░░░░░░░░░░░░░░░░░░░ ?/128k");
	expect(lines[2]).not.toMatch(/auto/);
});

test("renderFooter truncates all rendered lines to terminal width", () => {
	const lines = renderFooter(
		baseState({
			cwd: "/home/alice/a/very/long/path/to/a/repository",
			sessionName: "a very long session name",
			extensionStatuses: new Map([
				["status", "a very long extension status that must be truncated"],
			]),
		}),
		identityTheme,
		24,
	);

	expect(lines.length >= 4).toBeTruthy();
	for (const line of lines) {
		expect(visibleWidth(line) <= 24, `${line} exceeded width`).toBeTruthy();
	}
});
