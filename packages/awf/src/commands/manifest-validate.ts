import { failure, success, type Envelope } from "../envelope.ts";
import { loadManifest, ManifestValidationError } from "../manifest.ts";

export async function validateManifestCommand(
	path: string | undefined,
): Promise<Envelope> {
	if (path === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf manifest validate <file>",
		});
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
				"MANIFEST_VALIDATION_FAILED",
				"Workflow manifest validation failed.",
				{ issues: error.issues },
			);
		}
		return failure(
			"MANIFEST_LOAD_FAILED",
			"Workflow manifest could not be loaded.",
			{ message: error instanceof Error ? error.message : String(error) },
		);
	}
}
