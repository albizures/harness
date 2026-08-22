import { expect, it } from "vitest";
import { parseOutputFormat, serializeCliOutput } from "../../src/output.ts";

it("should ensure that --json is stripped from arguments and selects JSON output", () => {
	expect(parseOutputFormat(["--json", "--config", "awf.config.ts", "ready"])).toEqual({
		args: ["--config", "awf.config.ts", "ready"],
		format: "json",
	});
});

it("should ensure that text output renders help without requiring a subprocess", () => {
	const output = serializeCliOutput(
		{
			ok: true,
			data: {
				name: "awf",
				description: "Agent workflow CLI.",
				commands: [
					{ usage: "awf ready", description: "List ready work." },
				],
			},
		},
		"text",
	);

	expect(output).toContain("awf - Agent workflow CLI.");
	expect(output).toContain("awf ready  List ready work.");
	expect(output).toContain("Use --json for machine-readable output.");
});

it("should ensure that JSON output serializes the envelope exactly", () => {
	const output = serializeCliOutput(
		{ ok: true, data: { name: "awf", commands: [] } },
		"json",
	);

	expect(JSON.parse(output)).toEqual({
		ok: true,
		data: { name: "awf", commands: [] },
	});
});

it("should ensure that text output renders stable error details", () => {
	const output = serializeCliOutput(
		{
			ok: false,
			error: {
				code: "UNKNOWN_COMMAND",
				message: "Unknown command.",
				details: { command: "unknown" },
			},
		},
		"text",
	);

	expect(output).toBe("Error UNKNOWN_COMMAND: Unknown command.\ncommand: unknown\n");
});

it("should ensure that text output renders ready items and suggested commands", () => {
	const output = serializeCliOutput(
		{
			ok: true,
			data: {
				items: [
					{
						id: "42",
						title: "Implement CLI",
						workflow: {
							kind: "ticket",
							state: "ready",
							action: "implement",
						},
						suggestedCommand: { display: "awf start 42" },
					},
				],
			},
		},
		"text",
	);

	expect(output).toBe(
		"42 Implement CLI [ticket/ready/implement] — awf start 42\n",
	);
});

it("should ensure that text output renders issue, run, created issue, log, and manifest envelopes", () => {
	expect(
		serializeCliOutput(
			{
				ok: true,
				data: {
					issue: {
						id: "1",
						title: "Spec",
						workflow: { kind: "spec", state: "running", action: "plan" },
					},
					run: { id: "run-1", status: "active" },
					tickets: [{ id: "2", title: "Ticket" }],
				},
			},
			"text",
		),
	).toBe(
		"1 Spec [spec/running/plan]\nRun: run-1 (active)\nCreated issues:\n  2 Ticket\n",
	);

	expect(
		serializeCliOutput(
			{
				ok: true,
				data: { logs: [{ sequence: 1, type: "action_started", runId: "run-1" }] },
			},
			"text",
		),
	).toBe("1 action_started (run-1)\n");

	expect(
		serializeCliOutput(
			{ ok: true, data: { manifest: "agent-development", version: "v1" } },
			"text",
		),
	).toBe("Manifest agent-development v1\n");
});
