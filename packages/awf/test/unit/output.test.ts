import { expect, it } from "vitest";
import { parseOutputFormat, serializeCliOutput } from "../../src/output.ts";

it("should ensure that --json is stripped from arguments and selects JSON output", () => {
	expect(
		parseOutputFormat(["--json", "--config", "awf.config.ts", "ready"]),
	).toEqual({
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
				commands: [{ usage: "awf ready", description: "List ready work." }],
			},
		},
		"text",
	);

	expect(output).toContain("awf - Agent workflow CLI.");
	expect(output).toContain("awf ready  List ready work.");
	expect(output).toContain("Use --json for machine-readable output.");
});

it("should ensure that text help renders subkind selection separately from kind", () => {
	const output = serializeCliOutput(
		{
			ok: true,
			data: {
				name: "awf",
				commands: [],
				readiness: {
					subkinds: [{ kind: "task", values: ["work", "research"] }],
				},
			},
		},
		"text",
	);

	expect(output).toContain(
		"Subkinds:\n  task: work, research (task remains the kind)",
	);
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

	expect(output).toBe(
		"Error UNKNOWN_COMMAND: Unknown command.\ncommand: unknown\n",
	);
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

it("should ensure that text output renders Task subkind separately from lifecycle fields", () => {
	const output = serializeCliOutput(
		{
			ok: true,
			data: {
				items: [
					{
						id: "42",
						title: "Research CLI",
						workflow: {
							kind: "task",
							state: "ready",
							action: "work",
							subkind: "research",
						},
						suggestedCommand: { display: "awf start 42" },
					},
				],
			},
		},
		"text",
	);

	expect(output).toBe(
		"42 Research CLI [task/ready/work; subkind: research] — awf start 42\n",
	);
});

it("should ensure that text output renders workflow descriptions as deterministic Markdown", () => {
	const output = serializeCliOutput(
		{
			ok: true,
			data: {
				version: "v1",
				workflow: { id: "synthetic", version: "1.2.3" },
				vocabulary: {
					states: ["ready", "running", "done"],
					actions: ["implement", "none"],
					reasons: ["blocked"],
					events: ["start", "succeed"],
				},
				concurrency: { perIssue: 1, perWorkflow: 2, perKind: { ticket: 1 } },
				kinds: [
					{
						id: "ticket",
						label: "Ticket",
						subkinds: ["bug", "feature"],
						initial: { state: "ready", action: "implement" },
						transitions: [
							{
								from: { state: "ready", action: "implement" },
								event: "start",
								input: { required: true },
								to: {
									state: "running",
									action: "implement",
									reason: "blocked",
								},
							},
						],
					},
				],
				commands: [
					{
						id: "createTicket",
						target: { kind: "ticket", action: "implement" },
						cli: {
							verb: "create",
							target: "ticket",
							usage: "awf create ticket --input <file|->",
						},
						input: { required: true },
						output: { declared: false },
					},
				],
				readiness: {
					filters: [{ kind: "ticket", state: "ready", action: "implement" }],
				},
				lifecycle: {
					activeStates: ["running"],
					terminalStates: ["done"],
					retry: { allow: [{ kind: "ticket", action: "implement" }] },
				},
				relationships: [
					{
						id: "ticket-dependencies",
						from: "ticket",
						to: "ticket",
						projection: { type: "dependency", direction: "outbound" },
					},
				],
				scopeNotes: ["Describes the loaded Workflow manifest only."],
			},
		},
		"text",
	);

	expect(output).toBe(`# Workflow synthetic

- Manifest schema: v1
- Workflow version: 1.2.3

## Vocabulary

- States: ready, running, done
- Actions: implement, none
- Reasons: blocked
- Events: start, succeed

## Concurrency

- Per issue: 1
- Per workflow: 2
- Per kind ticket: 1

## Kinds

- ticket (Ticket)
  - Subkinds: bug, feature
  - Initial: ready/implement
  - Transitions:
    - ready/implement --start--> running/implement/blocked

## Commands

- createTicket
  - Usage: awf create ticket --input <file|->
  - Target: ticket/implement
  - Input: required

## Readiness

- Ready filters describe eligible workflow fields; they do not inspect current Tracker API state.
  - ticket/ready/implement

## Lifecycle policies

- Active states: running
- Terminal states: done
- Retry:
  - ticket/implement

## Relationships

- ticket-dependencies: ticket -> ticket (dependency, outbound)

## Scope notes

- Describes the loaded Workflow manifest only.
`);
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
				data: {
					issue: {
						id: "3",
						title: "Research",
						workflow: {
							kind: "task",
							state: "ready",
							action: "work",
							data: { subkind: "research" },
						},
					},
				},
			},
			"text",
		),
	).toBe("3 Research [task/ready/work; subkind: research]\n");

	expect(
		serializeCliOutput(
			{
				ok: true,
				data: {
					logs: [{ sequence: 1, type: "action_started", runId: "run-1" }],
				},
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
