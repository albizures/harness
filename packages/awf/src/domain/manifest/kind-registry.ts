import type { ManifestKind, WorkflowManifest } from "./schema.ts";

export type KindRegistry = {
	getExact: (id: string) => ManifestKind | undefined;
	getFamily: (id: string) => Array<ManifestKind>;
	isKnown: (id: string) => boolean;
	isMemberOf: (actual: string, family: string) => boolean;
};

export function createKindRegistry(manifest: WorkflowManifest): KindRegistry {
	const byId = new Map(manifest.kinds.map((kind) => [kind.id, kind]));
	return {
		getExact(id) {
			return byId.get(id);
		},
		getFamily(id) {
			return byId.has(id)
				? manifest.kinds.filter((kind) => isKindIdInFamily(kind.id, id))
				: [];
		},
		isKnown(id) {
			return byId.has(id);
		},
		isMemberOf(actual, family) {
			return byId.has(family) && isKindIdInFamily(actual, family);
		},
	};
}

export function isKindIdInFamily(actual: string, family: string): boolean {
	return actual === family || actual.startsWith(`${family}:`);
}

export function kindAncestry(id: string): Array<string> {
	const parts = id.split(":");
	return parts
		.slice(0, -1)
		.map((_, index) => parts.slice(0, index + 1).join(":"));
}

export function isValidKindId(value: string): boolean {
	return value
		.split(":")
		.every((part) => /^[a-z][a-z0-9-]*$/.test(part) && part !== "*");
}
