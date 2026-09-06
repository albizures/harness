import type { JsonValue } from "type-fest";
import { z } from "zod";
import { parseJsonRecord } from "../json.ts";
export type PayloadZodSchema = z.ZodType<unknown>;

export type StructuredWorkflowArtifactReference = {
	type: ArtifactKind;
	ref?: string;
	url?: string;
	path?: string;
	id?: string;
	title?: string;
	metadata?: Record<string, JsonValue>;
};

export type WorkflowArtifact = {
	id: string;
	kind: ArtifactKind;
	uri: string;
	name?: string;
} & Partial<StructuredWorkflowArtifactReference>;

export type WorkflowArtifactInput = Omit<WorkflowArtifact, "id"> & {
	id?: string;
};

export type ArtifactKind =
	| "markdown"
	| "inline"
	| "file"
	| "issue"
	| "pull-request"
	| "url"
	| "git-ref"
	| "handoff"
	| "finding";

const artifactMetadataKey = "awfArtifact";

export const artifacts = {
	string: () => z.string(),
	object: <const T extends z.ZodRawShape>(shape: T) => z.strictObject(shape),
	array: <T extends PayloadZodSchema>(item: T) => z.array(item),
	url: () => artifactReference("url"),
	file: () => artifactReference("file"),
	issue: () => artifactReference("issue"),
	pullRequest: () => artifactReference("pull-request"),
	gitRef: () => artifactReference("git-ref"),
	inlineMarkdown: () => artifactReference("markdown"),
	markdown: () => artifactReference("markdown"),
	inline: () => artifactReference("inline"),
	handoff: () => artifactReference("handoff"),
	finding: () => artifactReference("finding"),
};

export function validateArtifactReferenceValue(
	value: string,
	kind: ArtifactKind,
): string | undefined {
	if (value.trim() === "") {
		return "Artifact reference must be non-empty.";
	}
	switch (kind) {
		case "pull-request":
			return /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/u.test(value)
				? undefined
				: "Pull request artifact must be a GitHub pull request URL.";
		case "url":
			return /^https?:\/\//u.test(value)
				? undefined
				: "URL artifact must be http(s).";
		case "issue":
			return /^#\d+$/u.test(value) ||
				/^[a-z][a-z0-9-]*-\d+$/u.test(value) ||
				/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+$/u.test(value)
				? undefined
				: "Issue artifact must be a GitHub issue reference.";
		case "file":
			return !/^https?:\/\//u.test(value) && !value.startsWith("/")
				? undefined
				: "File artifact must be a relative path.";
		case "git-ref":
			return /\s/u.test(value)
				? "Git ref artifact must not contain whitespace."
				: undefined;
		default:
			return undefined;
	}
}

const structuredArtifactReferenceShape = {
	type: z.enum([
		"markdown",
		"inline",
		"file",
		"issue",
		"pull-request",
		"url",
		"git-ref",
		"handoff",
		"finding",
	]),
	ref: z.string().trim().optional(),
	url: z.string().trim().optional(),
	path: z.string().trim().optional(),
	id: z.string().trim().optional(),
	title: z.string().trim().optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
};

function artifactReference(kind: ArtifactKind): PayloadZodSchema {
	return structuredArtifactReference(kind).meta({
		[artifactMetadataKey]: kind,
	});
}

function structuredArtifactReference(kind: ArtifactKind): PayloadZodSchema {
	return z
		.strictObject(structuredArtifactReferenceShape)
		.superRefine((value, context) => {
			if (value.type !== kind) {
				context.addIssue({
					code: "custom",
					path: ["type"],
					message: `Artifact type must be '${kind}'.`,
				});
			}
			validateStructuredArtifactReference(value, kind, context);
		});
}

type StructuredArtifactReferenceInput = z.infer<
	ReturnType<typeof z.strictObject<typeof structuredArtifactReferenceShape>>
>;

function validateStructuredArtifactReference(
	value: StructuredArtifactReferenceInput,
	kind: ArtifactKind,
	context: z.RefinementCtx,
): void {
	if (kind === "pull-request" || kind === "url") {
		validateStructuredField(value.url, "url", kind, context);
		return;
	}
	if (kind === "file") {
		validateStructuredField(value.path, "path", kind, context);
		return;
	}
	if (kind === "git-ref") {
		validateStructuredField(value.ref, "ref", kind, context);
		return;
	}
	if (kind === "issue") {
		if (
			value.ref === undefined &&
			value.url === undefined &&
			value.id === undefined
		) {
			context.addIssue({
				code: "custom",
				path: ["ref"],
				message: "Issue artifact must include ref, url, or id.",
			});
			return;
		}
		if (value.ref !== undefined) {
			validateStructuredField(value.ref, "ref", kind, context);
		}
		if (value.url !== undefined) {
			validateStructuredField(value.url, "url", kind, context);
		}
		if (value.id !== undefined && value.id.trim() === "") {
			context.addIssue({
				code: "custom",
				path: ["id"],
				message: "Artifact reference must be non-empty.",
			});
		}
		return;
	}
	validateStructuredField(value.ref, "ref", kind, context);
}

function validateStructuredField(
	value: string | undefined,
	field: "ref" | "url" | "path",
	kind: ArtifactKind,
	context: z.RefinementCtx,
): void {
	if (value === undefined) {
		context.addIssue({
			code: "custom",
			path: [field],
			message: `Artifact reference must include ${field}.`,
		});
		return;
	}
	const message = validateArtifactReferenceValue(value, kind);
	if (message !== undefined) {
		context.addIssue({ code: "custom", path: [field], message });
	}
}

export function normalizeWorkflowArtifactInput(
	input: WorkflowArtifactInput,
	id: string,
): WorkflowArtifact {
	validateWorkflowArtifactInput(input);
	return {
		...compatibilityStructuredArtifactFields(input.kind, input.uri),
		...input,
		...(input.metadata === undefined
			? {}
			: { metadata: parseJsonRecord(input.metadata) }),
		type: input.type ?? input.kind,
		id,
	};
}

export function validateWorkflowArtifactInput(
	input: WorkflowArtifactInput,
): void {
	const uriIssue = validateArtifactReferenceValue(input.uri, input.kind);
	if (uriIssue !== undefined) {
		throw new Error(uriIssue);
	}
	if (input.type !== undefined && input.type !== input.kind) {
		throw new Error(`Artifact type must be '${input.kind}'.`);
	}
	if (input.metadata !== undefined) {
		parseJsonRecord(input.metadata);
	}
	for (const [field, value] of structuredArtifactFields(input.kind, input)) {
		const fieldIssue = validateArtifactReferenceValue(value, input.kind);
		if (fieldIssue !== undefined) {
			throw new Error(`${field}: ${fieldIssue}`);
		}
	}
}

function structuredArtifactFields(
	kind: ArtifactKind,
	input: WorkflowArtifactInput,
): Array<["ref" | "url" | "path", string]> {
	const field = structuredArtifactField(kind);
	const value = input[field];
	return value === undefined ? [] : [[field, value]];
}

function structuredArtifactField(kind: ArtifactKind): "ref" | "url" | "path" {
	if (kind === "pull-request" || kind === "url") {
		return "url";
	}
	if (kind === "file") {
		return "path";
	}
	return "ref";
}

function compatibilityStructuredArtifactFields(
	kind: ArtifactKind,
	uri: string,
): Partial<StructuredWorkflowArtifactReference> {
	if (kind === "pull-request" || kind === "url") {
		return { type: kind, url: uri };
	}
	if (kind === "file") {
		return { type: kind, path: uri };
	}
	return { type: kind, ref: uri };
}
