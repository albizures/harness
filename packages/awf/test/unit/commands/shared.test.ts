import { describe, expect, it } from "vitest";
import { proseLogMessage } from "../../../src/runtime/commands/shared.ts";

describe("proseLogMessage", () => {
	it("should use a validated non-empty summary exactly as the workflow log message", () => {
		expect(
			proseLogMessage("succeed", {
				summary: "Completed implementation.",
				checks: ["pnpm test"],
			}),
		).toBe("Completed implementation.");
	});

	it("should fall back to concise prose without serializing command input details", () => {
		expect(
			proseLogMessage("succeed", {
				outcome: { type: "completed", facts: ["Done"] },
				checks: ["pnpm test"],
				commandResult: { ok: true, data: { issue: "123" } },
			}),
		).toBe("Applied succeed.");
	});

	it("should ignore blank summaries and use concise prose", () => {
		expect(proseLogMessage("fail", { summary: "   " })).toBe("Applied fail.");
	});
});
