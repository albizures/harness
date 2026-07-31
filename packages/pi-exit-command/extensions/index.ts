import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// biome-ignore lint/style/noDefaultExport: Pi extension modules are loaded through default exports.
export default function (pi: ExtensionAPI) {
	pi.registerCommand("exit", {
		description: "Exit Pi",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}
