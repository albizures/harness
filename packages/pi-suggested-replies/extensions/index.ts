import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const MAX_SUGGESTIONS = 9;
export const WIDGET_ID = "suggested-replies";
const COMPACT_LAYOUT_WIDTH = 40;

export type ReplySuggestion = {
	label: string;
};

export type SuggestedRepliesState = {
	suggestions: Array<ReplySuggestion>;
	selectedIndex: number;
};

type SuggestedRepliesWidgetTheme = {
	fg: (color: "borderMuted", text: string) => string;
};

type BorderStyle = (text: string) => string;

const SuggestRepliesParams = {
	type: "object",
	properties: {
		suggestions: {
			type: "array",
			minItems: 1,
			maxItems: MAX_SUGGESTIONS,
			description:
				"Suggested replies the user can insert into the normal prompt editor.",
			items: {
				type: "object",
				properties: {
					label: {
						type: "string",
						description: "Reply text inserted into the prompt editor.",
					},
				},
				required: ["label"],
				additionalProperties: false,
			},
		},
	},
	required: ["suggestions"],
} as const;

// biome-ignore lint/style/noDefaultExport: Pi extension modules are loaded through default exports.
export default function suggestedReplies(pi: ExtensionAPI) {
	let state: SuggestedRepliesState | undefined;

	const clearSuggestions = (ctx: Pick<ExtensionContext, "ui">) => {
		state = undefined;
		ctx.ui.setWidget(WIDGET_ID, undefined);
	};

	const refreshWidget = (ctx: Pick<ExtensionContext, "ui">) => {
		ctx.ui.setWidget(
			WIDGET_ID,
			(_tui?: unknown, theme?: SuggestedRepliesWidgetTheme) => ({
				render: (width: number) =>
					renderSuggestedRepliesWidget(
						state,
						width,
						(text) => theme?.fg("borderMuted", text) ?? text,
					),
				invalidate() {},
			}),
		);
	};

	const showSuggestions = (
		ctx: Pick<ExtensionContext, "ui">,
		suggestions: Array<ReplySuggestion>,
	) => {
		state = {
			suggestions: normalizeSuggestions(suggestions),
			selectedIndex: 0,
		};
		refreshWidget(ctx);
	};

	const insertSuggestion = (
		ctx: Pick<ExtensionContext, "ui">,
		index: number,
	): boolean => {
		if (!state) {
			return false;
		}
		if (index < 0 || index >= state.suggestions.length) {
			return false;
		}

		const suggestion = state.suggestions[index];
		if (!suggestion) {
			return false;
		}
		state.selectedIndex = index;
		ctx.ui.setEditorText(suggestion.label);
		refreshWidget(ctx);
		return true;
	};

	const cycleSuggestion = (
		ctx: Pick<ExtensionContext, "ui">,
		direction: -1 | 1,
	): boolean => {
		if (!state || state.suggestions.length === 0) {
			return false;
		}
		const next = wrapIndex(
			state.selectedIndex + direction,
			state.suggestions.length,
		);
		return insertSuggestion(ctx, next);
	};

	pi.on("session_start", (_event, ctx) => {
		clearSuggestions(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearSuggestions(ctx);
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" as const };
		}
		if (state) {
			clearSuggestions(ctx);
		}
		return { action: "continue" as const };
	});

	pi.registerTool({
		name: "suggest_replies",
		label: "Suggest Replies",
		description:
			"Display ephemeral suggested replies that the user can insert into the normal prompt editor. Returns immediately without waiting for a selection.",
		promptSnippet:
			"Display suggested replies that the user can insert into the normal prompt editor",
		promptGuidelines: [
			"Use suggest_replies when the user would benefit from quick suggested replies such as confirmations, decisions, or short next-step responses.",
			"Do not use suggest_replies for required input; it is non-blocking and the user may ignore the suggestions and type normally.",
		],
		parameters: SuggestRepliesParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const suggestions = normalizeSuggestions(params.suggestions);
			if (suggestions.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No suggested replies displayed because no non-empty suggestions were provided.",
						},
					],
					details: {},
				};
			}
			if (suggestions.length > MAX_SUGGESTIONS) {
				return {
					content: [
						{
							type: "text",
							text: `No suggested replies displayed because at most ${MAX_SUGGESTIONS} suggestions are supported.`,
						},
					],
					details: {},
				};
			}

			showSuggestions(ctx, suggestions);
			return {
				content: [
					{
						type: "text",
						text: "Suggested replies displayed. The user may insert one into the prompt editor or type normally.",
					},
				],
				details: { suggestions },
			};
		},
	});

	pi.registerCommand("suggested-replies-demo", {
		description: "Show demo suggested replies.",
		handler: async (_args, ctx) => {
			showSuggestions(ctx, [
				{ label: "Yes, agree" },
				{ label: "Show alternatives first" },
				{ label: "Ask one clarifying question" },
			]);
			ctx.ui.notify("Demo suggested replies displayed.", "info");
		},
	});

	pi.registerCommand("suggested-reply", {
		description: "Insert a suggested reply by number.",
		handler: async (args, ctx) => {
			const index = parseSuggestionNumber(args);
			if (index === undefined) {
				ctx.ui.notify("Usage: /suggested-reply <number>", "warning");
				return;
			}
			if (!insertSuggestion(ctx, index)) {
				ctx.ui.notify("No suggested reply found for that number.", "warning");
			}
		},
	});

	pi.registerShortcut("f7", {
		description: "Insert the previous suggested reply.",
		handler: async (ctx) => {
			cycleSuggestion(ctx, -1);
		},
	});

	pi.registerShortcut("f8", {
		description: "Insert the next suggested reply.",
		handler: async (ctx) => {
			cycleSuggestion(ctx, 1);
		},
	});
}

export function normalizeSuggestions(
	suggestions: Array<ReplySuggestion>,
): Array<ReplySuggestion> {
	return suggestions
		.map((suggestion) => ({ label: suggestion.label.trim() }))
		.filter((suggestion) => suggestion.label.length > 0)
		.slice(0, MAX_SUGGESTIONS);
}

export function renderSuggestedRepliesWidget(
	state: SuggestedRepliesState | undefined,
	width: number,
	borderStyle: BorderStyle = (text) => text,
): Array<string> {
	if (!state || state.suggestions.length === 0) {
		return [];
	}
	if (width <= 0) {
		return [];
	}

	const contentLines = ["Suggested replies"];
	for (const [index, suggestion] of state.suggestions.entries()) {
		const marker = index === state.selectedIndex ? "›" : " ";
		contentLines.push(`${marker} ${index + 1}. ${suggestion.label}`);
	}
	contentLines.push("F7/F8 cycle • /suggested-reply <n> insert • Enter submit");

	return [
		renderTopBorder(width, borderStyle),
		...contentLines.map((line) =>
			renderSideBorderLine(line, width, borderStyle),
		),
	];
}

export function parseSuggestionNumber(args: string): number | undefined {
	const first = args.trim().split(/\s+/, 1)[0];
	if (!first) {
		return undefined;
	}
	const parsed = Number.parseInt(first, 10);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SUGGESTIONS) {
		return undefined;
	}
	return parsed - 1;
}

export function wrapIndex(index: number, length: number): number {
	return ((index % length) + length) % length;
}

function renderTopBorder(width: number, borderStyle: BorderStyle): string {
	if (width === 1) {
		return borderStyle("┌");
	}
	return borderStyle(`┌${"─".repeat(width - 2)}┐`);
}

function renderSideBorderLine(
	line: string,
	width: number,
	borderStyle: BorderStyle,
): string {
	if (width < COMPACT_LAYOUT_WIDTH) {
		const contentWidth = width - 1;
		if (contentWidth <= 0) {
			return "";
		}
		return `  ${truncatePlainLine(line, contentWidth)}`;
	}

	const contentWidth = width - 1;
	if (contentWidth <= 0) {
		return borderStyle("│");
	}
	return `  ${truncatePlainLine(line, contentWidth)}`;
}

function truncatePlainLine(line: string, width: number): string {
	if (width <= 0) {
		return "";
	}
	if (line.length <= width) {
		return line;
	}
	if (width === 1) {
		return "…";
	}
	return `${line.slice(0, width - 1)}…`;
}
