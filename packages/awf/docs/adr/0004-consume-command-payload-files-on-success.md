# ADR 0004: Consume command payload files on success

## Status

Accepted

AWF treats local command payload files as single-use artifacts: `--input <path>` command input files and Wayfinder `mapRevision.bodyFile` map body revision files are deleted after a command completes successfully, while `--input -` stdin payloads are not files and are never deleted. This is intentionally more opinionated than preserving reusable payload fixtures because AWF commands are commonly driven by generated handoff files whose continued presence creates stale retry hazards; failed commands leave files in place for diagnosis and retry, and cleanup failures are reported as warnings rather than rolling back successful workflow state.
