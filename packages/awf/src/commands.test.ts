import { expect, test } from "vitest";
import { execute } from "./commands.ts";
import { defaultManifest } from "./default-manifest.ts";
import type { Tracker } from "./tracker.ts";
import { createInMemoryTracker } from "./trackers/memory.ts";

test("fixed handoff runtime command is not publicly accepted", async () => {
	const envelope = await execute(["handoff", "ticket-1", "--input", "-"]);

	expect(envelope).toEqual({
		ok: false,
		error: {
			code: "UNKNOWN_COMMAND",
			message: "Unknown command.",
			details: { command: "handoff ticket-1 --input -" },
		},
	});
});

test("unknown manifest command targets are rejected before tracker mutation", async () => {
	const envelope = await execute(["create", "ticket", "--input", "-"], {
		tracker: createNoTouchTracker(),
		manifest: defaultManifest,
		stdin: "# Ticket\n",
	});

	expect(envelope).toEqual({
		ok: false,
		error: {
			code: "UNKNOWN_COMMAND_TARGET",
			message: "Workflow command target is not declared by the manifest.",
			details: { command: "create ticket" },
		},
	});
});

test("start records one high-level tracker intent instead of low-level writes", async () => {
	const seed = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});
	const issue = await seed.getIssue("123");
	const intents: Array<string> = [];
	const tracker: Tracker = {
		...createNoTouchTracker(),
		getIssue: async (id) => {
			expect(id).toBe("123");
			return issue;
		},
		startRun: async (id, input) => {
			intents.push("startRun");
			expect(id).toBe("123");
			expect(input.expect).toEqual({
				version: issue.workflow.version,
				hash: issue.workflow.hash,
			});
			expect(input.workflow.state).toBe("running");
			expect(input.workflow.action).toBe("implement");
			expect(input.log.type).toBe("action_started");
			expect(input.log.runId).toBe(input.runId);
			return {
				issue: {
					...issue,
					workflow: {
						...issue.workflow,
						state: "running",
						activeRunId: input.runId,
					},
				},
				log: { ...input.log, issueId: id, sequence: 1 },
			};
		},
	};

	const envelope = await execute(["start", "123"], { tracker });

	expect(envelope.ok).toBe(true);
	expect(intents).toEqual(["startRun"]);
});

function createNoTouchTracker(): Tracker {
	const touched = () => {
		throw new Error("tracker should not be touched");
	};
	return {
		createWorkflowIssue: touched,
		startRun: touched,
		completeRun: touched,
		recordArtifacts: touched,
		escalateWorkflow: touched,
		resumeWorkflow: touched,
		changeRelationship: touched,
		applyWorkflowEffects: touched,
		recordCommand: touched,
		advanceWorkflow: touched,
		repairIssue: touched,
		getIssue: touched,
		listIssues: touched,
		readLogs: touched,
	};
}

test("invalid arguments return a stable parse error envelope", async () => {
	const envelope = await execute(["succeed", "123"]);

	expect(envelope).toEqual({
		ok: false,
		error: {
			code: "INVALID_ARGUMENTS",
			message: "Invalid command arguments.",
			details: { usage: "awf succeed <id> --run <run> --input <file|->" },
		},
	});
});
