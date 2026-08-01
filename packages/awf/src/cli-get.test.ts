import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cliPath = new URL("./cli.ts", import.meta.url);

test("CLI smoke path reads a seeded in-memory workflow issue with a stable get envelope", () => {
	const result = spawnSync(process.execPath, [cliPath.pathname, "get", "42"], {
		encoding: "utf8",
		env: {
			...process.env,
			AWF_MEMORY_ISSUES: JSON.stringify([
				{
					id: "42",
					title: "Implement tracker",
					labels: [
						"awf:agent-development:kind:ticket",
						"awf:agent-development:state:ready",
						"awf:agent-development:action:implement",
					],
				},
			]),
		},
	});

	assert.equal(result.status, 0);
	assert.equal(result.stderr, "");
	const envelope = JSON.parse(result.stdout);
	assert.equal(envelope.ok, true);
	assert.deepEqual(envelope.data.issue, {
		id: "42",
		title: "Implement tracker",
		workflow: {
			kind: "ticket",
			state: "ready",
			action: "implement",
			version: 1,
			hash: "e9812f9a37bab3fda6fab06bf276533986787191c9d806cb01aff52b3d0c0e07",
		},
		relationships: { children: [], dependencies: [], dependents: [] },
		artifacts: [],
		changes: [],
	});
});
