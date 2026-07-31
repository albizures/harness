#!/usr/bin/env node
import { execute } from "./commands.ts";
import { serializeEnvelope } from "./envelope.ts";
import { CorruptWorkflowProjectionError, createInMemoryTrackerFromEnvironment } from "./tracker.ts";

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: { write(chunk: string): void };
  exitCode?: number;
};

try {
  const tracker = createInMemoryTrackerFromEnvironment(process.env);
  const envelope = await execute(process.argv.slice(2), { tracker });
  process.stdout.write(serializeEnvelope(envelope));
  process.exitCode = envelope.ok ? 0 : 1;
} catch (error) {
  if (error instanceof CorruptWorkflowProjectionError || error instanceof SyntaxError) {
    process.stdout.write(serializeEnvelope({ ok: false, error: { code: "CORRUPT_WORKFLOW_PROJECTION", message: error.message } }));
    process.exitCode = 1;
  } else {
    throw error;
  }
}
