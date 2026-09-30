import type { JsonValue } from "type-fest";
import type { WorkflowIssue } from "../../domain/workflow/issue.ts";
import type { WorkflowProjection } from "../../domain/workflow/projection.ts";
import type { Tracker } from "../../ports/tracker.ts";
import { type Envelope, success } from "../envelope.ts";

const LEGACY_SUBKINDS = new Set(["work", "research", "prototype"]);

export type LegacyTaskKindMigrationDiagnostic =
	| {
			code: "LEGACY_TASK_KIND_MIGRATION";
			severity: "info";
			id: string;
			fromKind: "task";
			toKind: string;
			legacySubkind: string;
			profile?: string;
			applied: boolean;
	  }
	| {
			code:
				| "LEGACY_TASK_SUBKIND_MISSING"
				| "LEGACY_TASK_SUBKIND_MALFORMED"
				| "LEGACY_TASK_SUBKIND_UNMAPPED";
			severity: "error";
			id: string;
			message: string;
			subkind?: JsonValue;
	  };

export type LegacyTaskKindMigrationResult = {
	migration: "legacy-task-subkinds";
	mode: "dry-run" | "apply";
	status: "clean" | "would-migrate" | "migrated" | "blocked";
	scanned: number;
	migrated: number;
	diagnostics: Array<LegacyTaskKindMigrationDiagnostic>;
};

export async function migrateLegacyTaskSubkindsCommand(
	tracker: Tracker,
	apply: boolean,
): Promise<Envelope> {
	const issues = await tracker.listIssues();
	const plans = issues.map(planIssueMigration).filter(isMigrationPlan);
	const blocked = plans.some((plan) => plan.kind === "error");
	const migrations = plans.filter(isReadyMigrationPlan);
	const applied = apply && !blocked;
	const diagnostics = plans.map((plan) => diagnosticForPlan(plan, applied));

	if (applied) {
		for (const plan of migrations) {
			await tracker.repairIssue(plan.issue.id, {
				expect: {
					version: plan.issue.workflow.version,
					hash: plan.issue.workflow.hash,
				},
				workflow: {
					kind: plan.toKind,
					data: plan.nextData,
				},
			});
		}
	}

	const status = migrationStatus(blocked, migrations.length, apply);

	return success({
		migration: "legacy-task-subkinds",
		mode: apply ? "apply" : "dry-run",
		status,
		scanned: issues.length,
		migrated: applied ? migrations.length : 0,
		diagnostics,
	} satisfies LegacyTaskKindMigrationResult);
}

type MigrationPlan =
	| {
			kind: "migrate";
			issue: WorkflowIssue;
			legacySubkind: "work" | "research" | "prototype";
			toKind: string;
			nextData: Record<string, JsonValue> | undefined;
			profile?: string;
	  }
	| {
			kind: "error";
			issue: WorkflowIssue;
			code:
				| "LEGACY_TASK_SUBKIND_MISSING"
				| "LEGACY_TASK_SUBKIND_MALFORMED"
				| "LEGACY_TASK_SUBKIND_UNMAPPED";
			message: string;
			subkind?: JsonValue;
	  }
	| { kind: "skip" };

function planIssueMigration(issue: WorkflowIssue): MigrationPlan {
	if (issue.workflow.kind !== "task") {
		return { kind: "skip" };
	}
	const data = issue.workflow.data;
	if (!isJsonRecord(data) || !Object.hasOwn(data, "subkind")) {
		return {
			kind: "error",
			issue,
			code: "LEGACY_TASK_SUBKIND_MISSING",
			message: "Legacy task issue is missing workflow.data.subkind.",
		};
	}
	const subkind = data.subkind;
	if (typeof subkind !== "string" || subkind.trim() === "") {
		return {
			kind: "error",
			issue,
			code: "LEGACY_TASK_SUBKIND_MALFORMED",
			message: "Legacy task issue has malformed workflow.data.subkind.",
			subkind,
		};
	}
	if (!LEGACY_SUBKINDS.has(subkind)) {
		return {
			kind: "error",
			issue,
			code: "LEGACY_TASK_SUBKIND_UNMAPPED",
			message: `Legacy task subkind '${subkind}' does not map to a concrete Task kind.`,
			subkind,
		};
	}
	const profile = typeof data.profile === "string" ? data.profile : undefined;
	return {
		kind: "migrate",
		issue,
		legacySubkind: subkind as "work" | "research" | "prototype",
		toKind: taskKindForLegacy(subkind, profile),
		nextData: withoutSubkind(data),
		...(profile === undefined ? {} : { profile }),
	};
}

function migrationStatus(
	blocked: boolean,
	migrationCount: number,
	apply: boolean,
): LegacyTaskKindMigrationResult["status"] {
	if (blocked) {
		return "blocked";
	}
	if (migrationCount === 0) {
		return "clean";
	}
	return apply ? "migrated" : "would-migrate";
}

function taskKindForLegacy(
	subkind: string,
	profile: string | undefined,
): string {
	if (subkind === "work" && profile === "integration-test") {
		return "task:work:integration-test";
	}
	if (subkind === "work" && profile === "merge") {
		return "task:work:merge";
	}
	return `task:${subkind}`;
}

function withoutSubkind(
	data: Record<string, JsonValue>,
): Record<string, JsonValue> | undefined {
	const { subkind: _subkind, ...rest } = data;
	return Object.keys(rest).length === 0 ? undefined : rest;
}

function diagnosticForPlan(
	plan: Exclude<MigrationPlan, { kind: "skip" }>,
	applied: boolean,
): LegacyTaskKindMigrationDiagnostic {
	if (plan.kind === "error") {
		return {
			code: plan.code,
			severity: "error",
			id: plan.issue.id,
			message: plan.message,
			...(plan.subkind === undefined ? {} : { subkind: plan.subkind }),
		};
	}
	return {
		code: "LEGACY_TASK_KIND_MIGRATION",
		severity: "info",
		id: plan.issue.id,
		fromKind: "task",
		toKind: plan.toKind,
		legacySubkind: plan.legacySubkind,
		...(plan.profile === undefined ? {} : { profile: plan.profile }),
		applied,
	};
}

function isMigrationPlan(
	plan: MigrationPlan,
): plan is Exclude<MigrationPlan, { kind: "skip" }> {
	return plan.kind !== "skip";
}

function isReadyMigrationPlan(
	plan: Exclude<MigrationPlan, { kind: "skip" }>,
): plan is Extract<MigrationPlan, { kind: "migrate" }> {
	return plan.kind === "migrate";
}

function isJsonRecord(
	value: WorkflowProjection["data"],
): value is Record<string, JsonValue> {
	return value !== undefined && value !== null && typeof value === "object";
}
