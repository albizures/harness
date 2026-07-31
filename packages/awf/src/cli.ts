#!/usr/bin/env node
import { execute } from "./commands.ts";
import { serializeEnvelope } from "./envelope.ts";

declare const process: {
  argv: string[];
  stdout: { write(chunk: string): void };
  exitCode?: number;
};

const envelope = execute(process.argv.slice(2));
process.stdout.write(serializeEnvelope(envelope));
process.exitCode = envelope.ok ? 0 : 1;
