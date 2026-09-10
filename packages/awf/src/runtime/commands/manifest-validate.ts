import { failure, success, type Envelope } from "../envelope.ts";
import { ManifestValidationError } from "../../domain/manifest/schema.ts";
import { loadManifest } from "../workflow-module.ts";
import { runtimeFailures } from "../failures.ts";

export async function validateManifestCommand(
	path: string | undefined,
): Promise<Envelope> {
	if (path === undefined) {
		return failure(
			runtimeFailures.invalidArguments({
				usage: "awf manifest validate <file>",
			}),
		);
	}

	try {
		const manifest = await loadManifest(path);
		return success({
			manifest: manifest.workflow.id,
			version: manifest.version,
			kinds: manifest.kinds.map((kind) => kind.id),
		});
	} catch (error) {
		if (error instanceof ManifestValidationError) {
			return failure(
				runtimeFailures.manifestValidationFailed({ issues: error.issues }),
			);
		}
		return failure(
			runtimeFailures.manifestLoadFailed({
				message: error instanceof Error ? error.message : String(error),
			}),
		);
	}
}
