import { expect, it } from "vitest";
import {
	parseOutputFormat,
	serializeCliOutput,
} from "../../../src/cli/output.ts";

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

it("should ensure that text help omits legacy subkind selection", () => {
	const output = serializeCliOutput(
		{
			ok: true,
			data: {
				name: "awf",
				commands: [],
				readiness: { subkinds: [] },
			},
		},
		"text",
	);

	expect(output).not.toContain("Subkinds:");
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
						suggestedCommand: { display: "awf run-command start 42" },
					},
				],
			},
		},
		"text",
	);

	expect(output).toBe(
		"42 Implement CLI [ticket/ready/implement] — awf run-command start 42\n",
	);
});

it("should ensure that text output renders ready blocked footer", () => {
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
					},
				],
				blocked: [
					{
						id: "99",
						title: "Blocked CLI",
						workflow: {
							kind: "ticket",
							state: "ready",
							action: "implement",
						},
						blocking: [],
					},
				],
			},
		},
		"text",
	);

	expect(output).toBe(
		"42 Implement CLI [ticket/ready/implement]\n\nBlocked work: 1. Use awf ready --blocked to inspect.\n",
	);
});

it("should ensure that text output renders blocked-only ready diagnostics", () => {
	const output = serializeCliOutput(
		{
			ok: true,
			data: {
				blocked: [
					{
						id: "99",
						title: "Blocked CLI",
						workflow: {
							kind: "ticket",
							state: "ready",
							action: "implement",
						},
						blocking: [
							{
								gate: "dependency",
								blockedBy: [{ id: "42", title: "Implement CLI" }],
							},
						],
					},
				],
			},
		},
		"text",
	);

	expect(output).toBe(
		"99 Blocked CLI [ticket/ready/implement] — blocked by dependency: 42 Implement CLI\n",
	);
});

it("should ensure that text output renders empty blocked-only diagnostics", () => {
	const output = serializeCliOutput(
		{ ok: true, data: { blocked: [] } },
		"text",
	);

	expect(output).toBe("No blocked work.\n");
});

it("should ensure that text output renders hierarchical Task kind in lifecycle fields", () => {
	const output = serializeCliOutput(
		{
			ok: true,
			data: {
				items: [
					{
						id: "42",
						title: "Research CLI",
						workflow: {
							kind: "task:research",
							state: "ready",
							action: "work",
						},
						suggestedCommand: { display: "awf run-command start 42" },
					},
				],
			},
		},
		"text",
	);

	expect(output).toBe(
		"42 Research CLI [task:research/ready/work] — awf run-command start 42\n",
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
				},
				relationships: [
					{
						id: "ticket-dependencies",
						from: "ticket",
						to: "ticket",
						projection: { type: "dependency" },
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
    - ready/implement --start--> running/implement

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

## Relationships

- ticket-dependencies: ticket -> ticket (dependency)

## Scope notes

- Describes the loaded Workflow manifest only.
`);
});

it("should ensure that awf get text output renders deterministic Markdown from the inspection payload", () => {
	const output = serializeCliOutput(
		{
			ok: true,
			data: {
				issue: {
					id: "303",
					title: "Render awf get text output",
					body: "Keep **Markdown** verbatim.\n\n- one\n- two",
					workflow: {
						kind: "task",
						state: "ready",
						action: "work",
						data: { subkind: "work" },
					},
					relationships: {
						parent: "300",
						children: ["304"],
						dependencies: ["301"],
						dependents: [],
						generatedBy: "302",
					},
				},
				relationships: {
					parent: {
						id: "300",
						title: "Spec",
						workflow: { kind: "spec", state: "running", action: "planning" },
					},
					children: [{ id: "304", missing: true }],
					dependencies: [
						{
							id: "301",
							title: "Shared payload",
							workflow: { kind: "task", state: "done", action: "none" },
						},
					],
					dependents: [],
					generatedBy: {
						id: "302",
						title: "Old task",
						workflow: { kind: "task", state: "failed", action: "none" },
					},
				},
				logs: [],
				recentLogs: [
					{ sequence: 1, type: "task-create_created", message: "created" },
					{ sequence: 2, type: "action_started" },
				],
			},
		},
		"text",
	);

	expect(output).toBe(`# 303 Render awf get text output [task/ready/work]

## Body

Keep **Markdown** verbatim.

- one
- two

## Relationships

### Parent

- 300 Spec [spec/running/planning]

### Children

- 304 (missing)

### Dependencies

- 301 Shared payload [task/done]

### Dependents

None.

### Generated by

- 302 Old task [task/failed]

## Recent logs

- 1 task-create_created — created
- 2 action_started
`);
});

it("should ensure that awf get text output renders empty body, relationships, and logs", () => {
	const output = serializeCliOutput(
		{
			ok: true,
			data: {
				issue: {
					id: "42",
					title: "Empty",
					workflow: { kind: "task", state: "ready", action: "work" },
					relationships: { children: [], dependencies: [], dependents: [] },
				},
				relationships: { children: [], dependencies: [], dependents: [] },
				logs: [],
				recentLogs: [],
			},
		},
		"text",
	);

	expect(output).toContain("## Body\n\n_No body._");
	expect(output).toContain("### Parent\n\nNone.");
	expect(output).toContain("## Recent logs\n\nNone.\n");
});

it("should ensure that awf logs text output names the issue when logs are absent", () => {
	expect(
		serializeCliOutput(
			{
				ok: true,
				data: { issueId: "target", logs: [] },
			},
			"text",
		),
	).toBe("No logs for target.\n");
});

it("should ensure that text output renders issue, created issue, log, and manifest envelopes", () => {
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
					tickets: [{ id: "2", title: "Ticket" }],
				},
			},
			"text",
		),
	).toBe("1 Spec [spec/running/plan]\nCreated issues:\n  2 Ticket\n");

	expect(
		serializeCliOutput(
			{
				ok: true,
				data: {
					issue: {
						id: "3",
						title: "Research",
						workflow: {
							kind: "task:research",
							state: "ready",
							action: "work",
						},
					},
				},
			},
			"text",
		),
	).toBe("3 Research [task:research/ready/work]\n");

	expect(
		serializeCliOutput(
			{
				ok: true,
				data: {
					logs: [
						{ sequence: 1, type: "action_started" },
						{ sequence: 2, type: "action_succeeded", message: "Done." },
					],
				},
			},
			"text",
		),
	).toBe("1 action_started\n2 action_succeeded — Done.\n");

	expect(
		serializeCliOutput(
			{ ok: true, data: { manifest: "agent-workflow", version: "v1" } },
			"text",
		),
	).toBe("Manifest agent-workflow v1\n");
});
