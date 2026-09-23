import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { createFileMentionAutocompleteProvider } from "./autocomplete.ts";
import {
	createFileMentionIndexProvider,
	type FileMentionIndexProvider,
	type FileMentionIndexProviderOptions,
} from "./indexer.ts";

type FileMentionsExtensionOptions = {
	createIndexProvider?: (
		options: FileMentionIndexProviderOptions,
	) => FileMentionIndexProvider;
};

export function registerFileMentionsExtension(
	pi: ExtensionAPI,
	options: FileMentionsExtensionOptions = {},
) {
	const createIndexProvider =
		options.createIndexProvider ?? createFileMentionIndexProvider;
	const providersByCwd = new Map<string, FileMentionIndexProvider>();

	function getProvider(cwd: string): FileMentionIndexProvider {
		const key = path.resolve(cwd);
		let provider = providersByCwd.get(key);
		if (!provider) {
			provider = createIndexProvider({ cwd: key });
			providersByCwd.set(key, provider);
		}
		return provider;
	}

	pi.registerCommand("file-mentions-refresh", {
		description: "Refresh File Mentions for the current working directory",
		handler: async (args, ctx) => {
			if (args.trim()) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"Usage: /file-mentions-refresh (path arguments are not supported).",
						"warning",
					);
				}
				return;
			}

			try {
				const index = await getProvider(ctx.cwd).refresh();
				if (ctx.hasUI) {
					ctx.ui.notify(
						index
							? "File Mentions refreshed."
							: "File Mentions refresh failed.",
						index ? "info" : "error",
					);
				}
			} catch {
				if (ctx.hasUI) {
					ctx.ui.notify("File Mentions refresh failed.", "error");
				}
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		const indexProvider = getProvider(ctx.cwd);
		ctx.ui.addAutocompleteProvider((current) =>
			createFileMentionAutocompleteProvider(current, indexProvider),
		);
	});
}

// biome-ignore lint/style/noDefaultExport: Pi extension modules are loaded through default exports.
export default function fileMentions(pi: ExtensionAPI) {
	registerFileMentionsExtension(pi);
}
