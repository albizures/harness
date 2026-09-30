# Plan Tasks

Break an approved plan, Spec, or conversation into Forge **Tasks** under an existing Spec. Use tracer-bullet vertical slices, preserve blockers, and add verification/release work for code changes.

## Required parent Spec

Require an existing Forge Spec. If the user did not supply a Spec id/URL and one is not unambiguously discoverable, stop and ask for it. Inspect the candidate with `forge show <record>` and confirm it is a Spec before drafting or publishing child Tasks.

## Process

### 1. Gather context

Use the existing conversation. For a supplied Spec, fetch it with `forge show` and `forge history` and read the body/history needed. Explore the codebase when necessary; use project glossary vocabulary and respect relevant ADRs.

Look for prefactoring opportunities: make the change easy, then make the easy change.

### 2. Draft vertical slices

Break the work into tracer-bullet Tasks:

- Each slice cuts a narrow but complete path through every relevant layer.
- Each completed slice is demoable or verifiable on its own.
- Each slice fits in a single fresh context window.
- Prefactoring comes first.

Give each Task its blocking edges. Wide refactors are the exception: sequence them as expand–contract, using an integration branch only when batches cannot stay green independently, and make final integration/verification explicit.

### 3. Add verification Tasks

For code work, add ordinary Forge Tasks by default unless the human explicitly opts out:

- **Verification Task**: state the integration/local verification to run.
- **Release Task**: state the release handoff required.

Gate verification after implementation/review and release after verification. If follow-up implementation or review Tasks are added after verification, add another Verification Task before release.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For every Task show its title, kind, blockers, delivered end-to-end behavior, and routing hint. Ask whether the granularity, edges, kinds, and routing are right. Iterate until approved; do not publish unapproved Tasks.

### 5. Publish

Create blockers before dependents with `forge new task`. Use `--description -` or `--description-file` for long descriptions. Use research, prototype, or review kinds only when approved and semantically right. Preserve every approved dependency with repeatable `--depends-on` or `forge deps add`.

Report every created id. Work the frontier through `forge ready`; do not close the parent Spec.
