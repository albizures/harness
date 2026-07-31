import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cliPath = new URL("./cli.ts", import.meta.url);

test("CLI writes success envelopes to stdout", () => {
  const result = spawnSync(process.execPath, [cliPath.pathname, "--help"], { encoding: "utf8" });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.name, "awf");
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
