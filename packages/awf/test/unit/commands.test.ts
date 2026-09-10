import { expect, it } from "vitest";
import { execute as rawExecute } from "../support/execute.ts";
import { agentDevelopmentManifest } from "../../src/workflows/agent-development/index.ts";

import type { Tracker } from "../../src/ports/tracker.ts";
import { createInMemoryTracker } from "../../src/adapters/trackers/memory.ts";

function execute(
	args: Parameters<typeof rawExecute>[0],
	options: Parameters<typeof rawExecute>[1] = {},
): ReturnType<typeof rawExecute> {
	return rawExecute(args, { manifest: agentDevelopmentManifest, ...options });
}
it("should ensure that fixed handoff runtime command is not publicly accepted", async () => {
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

it("should ensure that unknown manifest command targets are rejected before tracker mutation", async () => {
	const envelope = await execute(["create", "ticket", "--input", "-"], {
		tracker: createNoTouchTracker(),
		manifest: agentDevelopmentManifest,
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

it("should ensure that start records one high-level tracker intent instead of low-level writes", async () => {
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
		applyWorkflowEffects: async ({ effects }) => {
			intents.push("applyWorkflowEffects");
			expect(effects).toHaveLength(2);
			const update = effects[0];
			const record = effects[1];
			expect(update.type).toBe("update-workflow");
			if (update.type !== "update-workflow") {
				throw new Error("expected workflow update");
			}
			expect(update.issue).toEqual({ id: "123" });
			expect(update.expect).toEqual({
				version: issue.workflow.version,
				hash: issue.workflow.hash,
			});
			expect(update.workflow.state).toBe("running");
			expect(update.workflow.action).toBe("implement");
			expect(record.type).toBe("record-command");
			if (record.type !== "record-command") {
				throw new Error("expected command record");
			}
			expect(record.issue).toEqual({ id: "123" });
			expect(record.log.type).toBe("action_started");
			return {
				issues: {
					"123": {
						...issue,
						workflow: { ...issue.workflow, ...update.workflow },
					},
				},
				createdIssues: [],
				logs: [{ ...record.log, issueId: "123", sequence: 1 }],
			};
		},
	};

	const envelope = await execute(["run-command", "start", "123"], { tracker });

	expect(envelope.ok).toBe(true);
	expect(intents).toEqual(["applyWorkflowEffects"]);
});

function createNoTouchTracker(): Tracker {
	const touched = () => {
		throw new Error("tracker should not be touched");
	};
	return {
		createWorkflowIssue: touched,
		changeRelationship: touched,
		applyWorkflowEffects: touched,
		recordCommand: touched,
		repairIssue: touched,
		getIssue: touched,
		listIssues: touched,
		readLogs: touched,
	};
}

it("should ensure that lifecycle commands validate before issue lookup", async () => {
	for (const command of ["start", "succeed", "resume"]) {
		const envelope = await execute(["run-command", command, "123"]);

		expect(envelope).toEqual(
			command === "resume"
				? {
						ok: false,
						error: {
							code: "INVALID_ARGUMENTS",
							message: "Invalid command arguments.",
							details: { usage: "awf run-command resume <id> --action <action>" },
						},
					}
				: {
						ok: false,
						error: {
							code: "NOT_FOUND",
							message: "Workflow issue '123' was not found.",
							details: { id: "123" },
						},
					},
		);
	}
});
