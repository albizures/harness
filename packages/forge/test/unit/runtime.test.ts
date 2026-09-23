import { FileSystem } from "@effect/platform/FileSystem";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { runForgePromise } from "../../src/runtime.ts";

it("when running a Forge Effect program, it should provide the Node platform context", async () => {
	const exists = await runForgePromise(
		Effect.flatMap(FileSystem, (fileSystem) =>
			fileSystem.exists(process.cwd()),
		),
	);

	expect(exists).toBe(true);
});
