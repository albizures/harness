import { createHash } from "node:crypto";
import type { JsonValue } from "type-fest";
import type { WorkflowManifest } from "../../manifest.ts";
import {
	CorruptWorkflowProjectionError,
	IssueNotFoundError,
	type IssueRelationships,
	type WorkflowArtifact,
	type WorkflowChange,
	type WorkflowLog,
	type WorkflowProjection,
} from "../../tracker.ts";

const PROJECTION_SCHEMA_VERSION = 1;

export async function validateGitHubTrackerCapabilities(api: {
	capabilities: () => Promise<{ subIssues: boolean; dependencies: boolean }>;
}): Promise<void> {
	const capabilities = await api.capabilities();
	const missing = [
		...(capabilities.subIssues ? [] : ["native GitHub sub-issues"]),
		...(capabilities.dependencies ? [] : ["native GitHub issue dependencies"]),
	];
	if (missing.length > 0) {
		throw new CorruptWorkflowProjectionError(
			`GitHub tracker adapter requires ${missing.join(" and ")}.`,
		);
	}
}

export type ProjectionMetadata = {
	schemaVersion: number;
	workflow: WorkflowProjection;
	artifacts: Array<WorkflowArtifact>;
	changes: Array<WorkflowChange>;
};

export function hasWorkflowProjectionLabels(
	manifest: WorkflowManifest,
	labels: Array<string>,
): boolean {
	return labels.some((label) => label.startsWith(reservedPrefix(manifest)));
}

export function labelsForProjection(
	manifest: WorkflowManifest,
	projection: WorkflowProjection,
): Array<string> {
	const kind = manifest.kinds.find(
		(candidate) => candidate.id === projection.kind,
	);
	if (kind === undefined) {
		throw new CorruptWorkflowProjectionError(
			`Unknown workflow kind '${projection.kind}'.`,
		);
	}
	return [
		labelFor(manifest, "kind", kind.id),
		labelFor(manifest, "state", projection.state),
		labelFor(manifest, "action", projection.action),
		...(projection.reason === undefined
			? []
			: [labelFor(manifest, "reason", projection.reason)]),
	];
}

export function projectionFromLabels(
	manifest: WorkflowManifest,
	number: number,
	labels: Array<string>,
): Pick<WorkflowProjection, "kind" | "state" | "action" | "reason"> {
	const kindValues = valuesForReservedLabel(manifest, labels, "kind");
	if (kindValues.length !== 1 || kindValues[0] === "") {
		throw needsReconciliation(
			String(number),
			"issue must have exactly one workflow kind label",
		);
	}
	const kind = manifest.kinds.find(
		(candidate) => candidate.id === kindValues[0],
	);
	if (kind === undefined) {
		throw needsReconciliation(
			String(number),
			"issue has unknown workflow kind label",
		);
	}
	return {
		kind: kind.id,
		state: readSingleReservedLabel(manifest, labels, "state", number),
		action: readSingleReservedLabel(manifest, labels, "action", number),
		reason: readOptionalReservedLabel(manifest, labels, "reason", number),
	};
}

function readSingleReservedLabel(
	manifest: WorkflowManifest,
	labels: Array<string>,
	field: "state" | "action",
	number: number,
): string {
	const values = valuesForReservedLabel(manifest, labels, field);
	if (values.length !== 1 || values[0] === "") {
		throw needsReconciliation(
			String(number),
			`issue must have exactly one ${field} workflow label`,
		);
	}
	return values[0] ?? "";
}

function readOptionalReservedLabel(
	manifest: WorkflowManifest,
	labels: Array<string>,
	field: "reason",
	number: number,
): string | undefined {
	const values = valuesForReservedLabel(manifest, labels, field);
	if (values.length > 1 || values.some((value) => value === "")) {
		throw needsReconciliation(
			String(number),
			`issue has corrupt ${field} workflow labels`,
		);
	}
	return values[0];
}

function valuesForReservedLabel(
	manifest: WorkflowManifest,
	labels: Array<string>,
	field: "kind" | "state" | "action" | "reason",
): Array<string> {
	const prefix = reservedPrefix(manifest, field);
	return labels
		.filter((label) => label.startsWith(prefix))
		.map((label) => label.slice(prefix.length));
}

function labelFor(
	manifest: WorkflowManifest,
	field: "kind" | "state" | "action" | "reason",
	value: string,
): string {
	return `${reservedPrefix(manifest, field)}${value}`;
}

function reservedPrefix(
	manifest: WorkflowManifest,
	field?: "kind" | "state" | "action" | "reason",
): string {
	const prefix = `${manifest.github.reservedPrefix}:${manifest.workflow.id}:`;
	return field === undefined ? prefix : `${prefix}${field}:`;
}

export function projectionMarker(manifest: WorkflowManifest): string {
	return `${manifest.github.reservedPrefix}:${manifest.workflow.id}:projection`;
}

export function logMarker(manifest: WorkflowManifest): string {
	return `${manifest.github.reservedPrefix}:${manifest.workflow.id}:log`;
}

export function machineComment(marker: string, payload: unknown): string {
	return `<!-- ${marker}\n${stableStringify(payload)}\n-->`;
}

export function parseMachineComment(
	body: string,
	marker: string,
): unknown | undefined {
	const trimmed = body.trim();
	const prefix = `<!-- ${marker}\n`;
	if (!trimmed.startsWith(prefix)) {
		return undefined;
	}
	if (!trimmed.endsWith("\n-->")) {
		throw new CorruptWorkflowProjectionError(
			"NEED_RECONCILIATION: malformed machine comment marker.",
		);
	}
	const json = trimmed.slice(prefix.length, -"\n-->".length);
	try {
		return JSON.parse(json) as unknown;
	} catch {
		throw new CorruptWorkflowProjectionError(
			"NEED_RECONCILIATION: malformed machine comment JSON.",
		);
	}
}

export function metadataFromProjection(
	workflow: WorkflowProjection,
	artifacts: Array<WorkflowArtifact>,
	changes: Array<WorkflowChange>,
): ProjectionMetadata {
	return {
		schemaVersion: PROJECTION_SCHEMA_VERSION,
		workflow,
		artifacts: cloneJson(artifacts) as Array<WorkflowArtifact>,
		changes: cloneJson(changes) as Array<WorkflowChange>,
	};
}

export function isProjectionMetadata(
	value: unknown,
): value is ProjectionMetadata {
	if (!isRecord(value) || !isRecord(value.workflow)) {
		return false;
	}
	return (
		value.schemaVersion === PROJECTION_SCHEMA_VERSION &&
		isProjection(value.workflow) &&
		Array.isArray(value.artifacts) &&
		Array.isArray(value.changes)
	);
}

export function isProjection(value: unknown): value is WorkflowProjection {
	return (
		isRecord(value) &&
		typeof value.kind === "string" &&
		typeof value.state === "string" &&
		typeof value.action === "string" &&
		(value.reason === undefined || typeof value.reason === "string") &&
		(value.activeRunId === undefined ||
			typeof value.activeRunId === "string") &&
		typeof value.version === "number" &&
		typeof value.hash === "string"
	);
}

export function isWorkflowLog(value: unknown): value is WorkflowLog {
	return (
		isRecord(value) &&
		typeof value.sequence === "number" &&
		typeof value.issueId === "string" &&
		typeof value.type === "string" &&
		(value.runId === undefined || typeof value.runId === "string")
	);
}

export function validateProjectionShape(
	id: string,
	projection: WorkflowProjection,
): void {
	for (const field of ["kind", "state", "action"] as const) {
		if (projection[field] === "") {
			throw needsReconciliation(id, `malformed ${field} projection data`);
		}
	}
	if (projection.reason === "" || projection.activeRunId === "") {
		throw needsReconciliation(id, "malformed optional projection data");
	}
}

export function withHash(
	projection: Omit<WorkflowProjection, "hash"> | WorkflowProjection,
): WorkflowProjection {
	const { hash: _hash, ...withoutHash } = projection as WorkflowProjection;
	return { ...withoutHash, hash: hashProjection(withoutHash) };
}

export function hashProjection(
	projection: Omit<WorkflowProjection, "hash">,
): string {
	return createHash("sha256").update(stableStringify(projection)).digest("hex");
}

export function sameProjection(
	left: WorkflowProjection,
	right: WorkflowProjection,
): boolean {
	return stableStringify(left) === stableStringify(right);
}

export function sameJson(left: unknown, right: unknown): boolean {
	return stableStringify(left) === stableStringify(right);
}

export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function normalizeRelationships(
	relationships: Partial<IssueRelationships>,
): IssueRelationships {
	return {
		...(relationships.parent === undefined
			? {}
			: { parent: relationships.parent }),
		children: [...(relationships.children ?? [])],
		dependencies: [...(relationships.dependencies ?? [])],
		dependents: [...(relationships.dependents ?? [])],
	};
}

export function parseIssueNumber(id: string): number {
	const number = Number(id);
	if (!Number.isInteger(number) || number < 1) {
		throw new IssueNotFoundError(id);
	}
	return number;
}

export function validatePullRequestArtifact(kind: string, uri: string): void {
	if (
		kind === "pull-request" &&
		!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/u.test(uri)
	) {
		throw new CorruptWorkflowProjectionError(
			"Pull request artifact must be a GitHub pull request URL.",
		);
	}
}

export function needsReconciliation(
	id: string,
	reason: string,
): CorruptWorkflowProjectionError {
	return new CorruptWorkflowProjectionError(
		`NEED_RECONCILIATION: Issue '${id}' ${reason}.`,
	);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function cloneJson(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

export function asObject(
	value: JsonValue | undefined,
): Record<string, JsonValue> {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, JsonValue>;
	}
	return {};
}
