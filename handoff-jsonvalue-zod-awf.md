# Handoff: AWF `JsonValue` / Zod boundary review

## Context

The user wants to review `JsonValue` usage in `packages/awf` and decide where Zod runtime validation should replace or surround it. No code changes have been made yet.

A repository search found `JsonValue` usages only under `packages/awf/src`.

## Decisions reached

- Scope is limited to `packages/awf`.
- Classify each `JsonValue` usage into:
  - **keep as generic JSON**, or
  - **replace/narrow with Zod validation**.
- “Use Zod” means runtime validation at trust boundaries plus `z.infer`/narrowed types where helpful, not just TypeScript type replacement.
- Adopt a hybrid boundary policy:
  - Use `unknown` at ingress/decode boundaries.
  - Validate shape with Zod before access.
  - Validate JSON-compatibility after Zod parsing before storing/emitting.
  - Keep `JsonValue` for already-proven AWF JSON transport/storage contracts.
- Specifically, change `parseJsonInput` to return `Envelope<unknown>` and let schema-specific code convert to `JsonValue` only at write boundaries.
- Payload schemas should produce JSON-compatible values; reject non-JSON after Zod parsing.

## Classification produced

### Keep as generic JSON

- `packages/awf/src/envelope.ts`
  - `SuccessEnvelope<T extends JsonValue>`
  - `ErrorEnvelope.details`
  - `Envelope<T>`
  - `success(...)`, `failure(...)`
  - Rationale: envelopes promise JSON-serializable CLI/API output.

- `packages/awf/src/tracker.ts`
  - `StructuredWorkflowArtifactReference.metadata?: Record<string, JsonValue>`
  - `WorkflowLog.payload?: JsonValue`
  - Rationale: tracker artifacts/logs are persisted JSON. Callers should only produce these after validation.

- `packages/awf/src/output.ts`
  - formatter input/utility types
  - Rationale: renders already-formed envelopes. Optional later improvement: typed output variants.

- `packages/awf/src/cli-config.ts`
  - `configFailure(... details: Record<string, JsonValue>)`
  - `errorDetails(...)`
  - Rationale: error details are envelope JSON.

- `packages/awf/src/commands/shared.ts`
  - readiness blocking return values: `Array<Record<string, JsonValue>>`
  - `terminalLogInputMatches(payload: JsonValue | undefined, input: JsonValue)`
  - Rationale: these are output/log comparison structures.

### Replace/narrow with `unknown` + Zod validation

- `packages/awf/src/commands/shared.ts`
  - `parseJsonInput(raw, code): Envelope<JsonValue>`
  - `JSON.parse(raw) as JsonValue`
  - Recommendation: change to `Envelope<unknown>`.

- `packages/awf/src/commands/shared.ts`
  - `validateWorkflowCommandInput(command, value: JsonValue)`
  - `validateWorkflowCommandOutput(command, value: JsonValue)`
  - Recommendation: accept `unknown`; return/use parsed data or helper.

- `packages/awf/src/commands/lifecycle.ts`
  - `const terminalInput = payload.value as JsonValue`
  - `input: parsedInput.data as JsonValue`
  - Recommendation: replace casts with JSON-compatible validation after Zod parsing.

- `packages/awf/src/commands/create-apply.ts`
  - `payload.value.handoff as JsonValue | undefined`
  - `input: payload.value as JsonValue`
  - `issues: validationIssues as JsonValue`
  - `dependsOn: ticket.dependsOn as Array<string> | undefined`
  - Recommendation: replace casts with schema/helper validation or stronger parsed types.

- `packages/awf/src/commands/shared.ts`
  - `BundledArtifactInput = ... & Record<string, JsonValue>`
  - `structuredArtifactInput(value: JsonValue | undefined, ...)`
  - `pullRequestArtifactInput(value: JsonValue | undefined, ...)`
  - Recommendation: narrow via Zod artifact schemas rather than accepting generic JSON and casting.

### Replace hand-written JSON validators with shared Zod schema

- `packages/awf/src/trackers/github/helpers.ts`
  - `isJsonRecord`
  - `isJsonValue`
  - `asObject(value: JsonValue | undefined)`

- `packages/awf/src/trackers/state.ts`
  - `asObject(value: JsonValue | undefined)`

Recommendation: use shared `jsonValueSchema` / `jsonRecordSchema`.

## Concrete refactor plan

1. Add shared JSON schemas, likely `packages/awf/src/json.ts`:

   ```ts
   import { z } from "zod";
   import type { JsonValue } from "type-fest";

   export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
   	z.union([
   		z.string(),
   		z.number(),
   		z.boolean(),
   		z.null(),
   		z.array(jsonValueSchema),
   		z.record(z.string(), jsonValueSchema),
   	]),
   );

   export const jsonRecordSchema = z.record(z.string(), jsonValueSchema);
   ```

2. Change `parseJsonInput` in `packages/awf/src/commands/shared.ts` to return `Envelope<unknown>` and remove `as JsonValue` from `JSON.parse`.

3. Add a helper that composes manifest/bundled Zod validation with JSON-compatibility validation, e.g. `parseJsonPayloadValue(...)`:
   - call existing `parsePayloadValue(...)`,
   - if shape validation succeeds, run `jsonValueSchema.safeParse(payload.value)`,
   - return `JsonValue` plus validation issues.

4. Update command paths to use the helper before logging/storing/emitting:
   - `terminalCommand`
   - `escalateCommand`
   - `createGenericWorkflowIssueCommand`
   - `applyGenericWorkflowCommand`
   - `createHandoffCommand`
   - `applyPlanCommand`

5. Tighten bundled artifact extraction:
   - make `structuredArtifactInput` accept `unknown`,
   - validate using existing artifact Zod schemas in `manifest.ts`, or expose a reusable artifact reference parser.

6. Replace tracker helper casts/hand-written JSON guards with `jsonRecordSchema.safeParse(...)`.
   - Decide per call site whether invalid data means fallback `{}` or tracker corruption/reconciliation.

## Suggested skills

- `tdd`: Use for the implementation. This refactor should be test-first because it changes command input validation and persisted payload boundaries.
- `diagnosing-bugs`: Use if changing `parseJsonInput` to `unknown` causes confusing type/runtime failures across command paths.
- `codebase-design`: Use if the next agent wants to refine the AWF JSON boundary/interface before editing.
- `domain-modeling`: Use only if the JSON boundary policy should be captured in repo glossary/ADR terms.

## Notes for next agent

- No files were edited except this handoff document.
- No tests were run.
- The user asked for a classification plus concrete refactor plan, not implementation yet.
- Be careful not to remove `JsonValue` from public transport/storage contracts where it communicates JSON-serializability.
