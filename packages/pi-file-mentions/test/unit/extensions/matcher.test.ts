// biome-ignore-all lint/style/noMagicNumbers: Test literals define matcher scoring and cap behavior.
import { expect, test } from "vitest";
import {
	matchFileMentions,
	prepareFileMentionInsertion,
	type FileMentionIndex,
} from "../../../extensions/matcher.ts";

type TestIndexEntry = FileMentionIndex["entries"][number];

function entry(kind: TestIndexEntry["kind"], path: string): TestIndexEntry {
	return {
		kind,
		path,
		depth: path.split("/").length,
		basename: path.split("/").at(-1) ?? path,
	};
}

const index: FileMentionIndex = {
	projectRoot: "/repo",
	entries: [
		entry("directory", "src"),
		entry("directory", "src/components"),
		entry("directory", "src/components/Button"),
		entry("directory", "docs/components"),
		entry("directory", "packages/button-kit"),
		entry("file", "src/components/Button/index.ts"),
		entry("file", "src/components/Button/Button.tsx"),
		entry("file", "src/components/Button/internal/use-button.ts"),
		entry("file", "src/components/Card.tsx"),
		entry("file", "docs/components/button.md"),
		entry("file", "packages/button-kit/src/index.ts"),
	],
};

test("when matching folders, basename matches outrank path-only matches", () => {
	const suggestions = matchFileMentions(index, "button");

	expect(
		suggestions
			.filter((item) => item.kind === "folder")
			.map((item) => item.path),
	).toEqual(["src/components/Button", "packages/button-kit"]);
});

test("when expanding matched folders, recursive files appear below their folder", () => {
	const suggestions = matchFileMentions(index, "button");

	expect(suggestions.slice(0, 4).map((item) => [item.kind, item.path])).toEqual(
		[
			["folder", "src/components/Button"],
			["file", "src/components/Button/index.ts"],
			["file", "src/components/Button/Button.tsx"],
			["file", "src/components/Button/internal/use-button.ts"],
		],
	);
});

test("when an ancestor folder matches, descendant folders are not included unless independently matched", () => {
	const srcSuggestions = matchFileMentions(index, "src");
	expect(
		srcSuggestions
			.filter((item) => item.kind === "folder")
			.map((item) => item.path),
	).toEqual(["src"]);

	const buttonSuggestions = matchFileMentions(index, "button");
	expect(
		buttonSuggestions.some(
			(item) => item.kind === "folder" && item.path === "src/components/Button",
		),
	).toBeTruthy();
});

test("when applying caps, only five folders, twenty files per folder, and fifty total suggestions are returned", () => {
	const cappedIndex: FileMentionIndex = {
		projectRoot: "/repo",
		entries: [
			...Array.from({ length: 8 }, (_, folderIndex) =>
				entry("directory", `area-${folderIndex}/target-folder`),
			),
			...Array.from({ length: 8 }, (_, folderIndex) =>
				Array.from({ length: 30 }, (_, fileIndex) =>
					entry(
						"file",
						`area-${folderIndex}/target-folder/file-${fileIndex}.ts`,
					),
				),
			).flat(),
		],
	};

	const suggestions = matchFileMentions(cappedIndex, "target");

	expect(suggestions.length).toBe(50);
	expect(suggestions.filter((item) => item.kind === "folder").length).toBe(5);
	for (const folder of suggestions.filter((item) => item.kind === "folder")) {
		expect(
			suggestions.filter((item) => item.matchedFolderPath === folder.path)
				.length <= 20,
		).toBeTruthy();
	}
});

test("when ordering files under a matched folder, shallow and short paths win before locale order", () => {
	const ordered = matchFileMentions(
		{
			projectRoot: "/repo",
			entries: [
				entry("directory", "src/lib"),
				entry("file", "src/lib/z.ts"),
				entry("file", "src/lib/a-long-name.ts"),
				entry("file", "src/lib/deep/a.ts"),
			],
		},
		"lib",
	).map((item) => item.path);

	expect(ordered).toEqual([
		"src/lib",
		"src/lib/z.ts",
		"src/lib/a-long-name.ts",
		"src/lib/deep/a.ts",
	]);
});

test("when matching an absolute query, folders are matched against absolute paths", () => {
	const suggestions = matchFileMentions(index, "/repo/src/components/but");

	expect(suggestions[0]?.path).toBe("src/components/Button");
	expect(suggestions[0]?.insertText).toBe("@/repo/src/components/Button");
});

test("when preparing insertion values, absolute queries stay absolute and relative queries stay relative", () => {
	const suggestion = {
		kind: "file" as const,
		path: "src/components/Button/index.ts",
		absolutePath: "/repo/src/components/Button/index.ts",
		score: 10,
		insertText: "",
	};

	expect(
		prepareFileMentionInsertion("/repo/src/com", suggestion).insertText,
	).toBe("@/repo/src/components/Button/index.ts");
	expect(prepareFileMentionInsertion("src/com", suggestion).insertText).toBe(
		"@src/components/Button/index.ts",
	);
});

test("when paths contain spaces or the query is quoted, insertion uses quoted file mention syntax", () => {
	const suggestion = {
		kind: "file" as const,
		path: "docs/quoted file.md",
		absolutePath: "/repo/docs/quoted file.md",
		score: 10,
		insertText: "",
	};

	expect(prepareFileMentionInsertion("docs/quo", suggestion).insertText).toBe(
		'@"docs/quoted file.md"',
	);
	expect(
		prepareFileMentionInsertion('"docs/quo', {
			...suggestion,
			path: "docs/plain.md",
		}).insertText,
	).toBe('@"docs/plain.md"');
	expect(
		prepareFileMentionInsertion("docs/quo", {
			...suggestion,
			path: 'docs/has "quote".md',
		}).insertText,
	).toBe('@"docs/has \\"quote\\".md"');
});
