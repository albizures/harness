import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cliPath = new URL("./cli.ts", import.meta.url);
const validManifestPath = new URL("./fixtures/valid.workflow.ts", import.meta.url).pathname;
const badManifestPath = new URL("./fixtures/bad.workflow.ts", import.meta.url).pathname;

test("CLI writes success envelopes to stdout", () => {
  const result = spawnSync(process.execPath, [cliPath.pathname, "--help"], { encoding: "utf8" });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.name, "awf");
});

test("CLI smoke path loads a fixture manifest and returns a JSON success envelope", () => {
  const result = spawnSync(process.execPath, [cliPath.pathname, "manifest", "validate", validManifestPath], { encoding: "utf8" });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    data: { manifest: "agent-development", version: "v1", kinds: ["spec", "ticket"] },
  });
});

test("CLI returns a stable validation error envelope for a bad manifest", () => {
  const result = spawnSync(process.execPath, [cliPath.pathname, "manifest", "validate", badManifestPath], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "MANIFEST_VALIDATION_FAILED");
  assert.match(JSON.stringify(envelope.error.details.issues), /wildcard/);
});

test("CLI writes error envelopes to stdout and exits non-zero", () => {
  const result = spawnSync(process.execPath, [cliPath.pathname, "unknown"], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    error: {
      code: "UNKNOWN_COMMAND",
      message: "Unknown command.",
      details: { command: "unknown" },
    },
  });
});
