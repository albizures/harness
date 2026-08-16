import { z } from "zod";
export type PayloadZodSchema = z.ZodType<unknown>;

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
