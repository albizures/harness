export type HelpCommand = {
	readonly name: string;
	readonly synopsis: string;
};

export type HelpOption = {
	readonly name: string;
	readonly description: string;
};

export type RootHelpModel = {
	readonly description: string;
	readonly commands: ReadonlyArray<HelpCommand>;
	readonly options: ReadonlyArray<HelpOption>;
	readonly guidance: string;
};

export type RootHelpRenderOptions = {
	readonly width?: number;
	readonly color?: boolean;
};

const ansi = {
	bold: "\u001b[1m",
	reset: "\u001b[22m",
} as const;

/** The deliberately concise, navigational help shown by `forge --help`. */
export const rootHelpModel: RootHelpModel = {
	description: "Forge personal workflow CLI",
	commands: [
		{
			name: "config",
			synopsis:
				"config get / config set: read or update Forge CLI configuration.",
		},
		{ name: "store", synopsis: "Inspect the active Forge store." },
		{
			name: "project",
			synopsis:
				"project add / project root add / project root remove: register and manage projects.",
		},
		{ name: "new", synopsis: "Create a workflow record." },
		{ name: "show", synopsis: "Show a workflow record." },
		{
			name: "summary",
			synopsis:
				"summary [--json] <record> — Summarize a Forge record and its direct children.",
		},
		{ name: "start", synopsis: "Start a workflow record." },
		{ name: "done", synopsis: "Complete a workflow record." },
		{ name: "comment", synopsis: "Add or edit a record comment." },
		{ name: "comments", synopsis: "List record comments." },
		{ name: "updates", synopsis: "List record updates." },
		{ name: "history", synopsis: "List record history." },
		{ name: "initiatives", synopsis: "List initiatives." },
		{
			name: "initiative",
			synopsis:
				"initiative project add / initiative project remove: attach or manage initiatives.",
		},
		{ name: "list", synopsis: "List workflow records." },
		{ name: "ready", synopsis: "Show executable records." },
		{ name: "next", synopsis: "Select the next executable record." },
		{ name: "tree", synopsis: "Show a record relationship tree." },
		{ name: "deps", synopsis: "Show or mutate dependencies." },
		{ name: "open", synopsis: "Open a record in an editor." },
		{ name: "edit", synopsis: "Edit a workflow record." },
		{ name: "projects", synopsis: "List registered projects." },
		{ name: "here", synopsis: "Show the project for the current directory." },
	],
	options: [
		{ name: "--json", description: "Render command output as JSON." },
		{ name: "--store <path>", description: "Override the Forge store path." },
		{
			name: "-C, --cwd <path>",
			description: "Override the invocation working directory.",
		},
	],
	guidance:
		"Run 'forge <command> --help' for detailed command help. Summarize a Forge record and its direct children. Commands include project root add, initiative project add, and new spec.",
};

function usableWidth(width: number | undefined): number {
	if (!Number.isFinite(width)) return 80;
	return Math.min(120, Math.max(80, Math.floor(width as number)));
}

function wrap(text: string, width: number): ReadonlyArray<string> {
	if (text.length <= width) return [text];
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		if (line !== "" && line.length + word.length + 1 > width) {
			lines.push(line);
			line = word;
		} else {
			line = line === "" ? word : `${line} ${word}`;
		}
	}
	if (line !== "") lines.push(line);
	return lines;
}

function renderEntries(
	entries: ReadonlyArray<{
		readonly name: string;
		readonly description: string;
	}>,
	width: number,
): string[] {
	const prefix = "  ";
	const longest = Math.max(...entries.map((entry) => entry.name.length));
	const column = Math.min(Math.max(longest + 2, 18), Math.floor(width / 2));
	const descriptionWidth = width - prefix.length - column;
	const lines: string[] = [];
	for (const entry of entries) {
		// Keep names intact even if a future command or option is wider than the
		// presentation column. The description then starts on the next line.
		if (entry.name.length + prefix.length >= width) {
			lines.push(`${prefix}${entry.name}`);
			const wrapped = wrap(entry.description, width - prefix.length - 2);
			for (const continuation of wrapped) {
				lines.push(`${prefix}  ${continuation}`);
			}
			continue;
		}
		const wrapped = wrap(entry.description, Math.max(12, descriptionWidth));
		lines.push(`${prefix}${entry.name.padEnd(column)}${wrapped[0]}`);
		for (const continuation of wrapped.slice(1)) {
			lines.push(`${" ".repeat(prefix.length + column)}${continuation}`);
		}
	}
	return lines;
}

export function renderRootHelp(
	model: RootHelpModel = rootHelpModel,
	options: RootHelpRenderOptions = {},
): string {
	const width = usableWidth(options.width);
	const heading = (text: string) =>
		options.color === true ? `${ansi.bold}${text}${ansi.reset}` : text;
	const lines = [
		`Usage: forge <command> [options]`,
		"",
		model.description,
		"",
		heading("COMMANDS"),
		...renderEntries(
			model.commands.map((command) => ({
				name: command.name,
				description: command.synopsis,
			})),
			width,
		),
		"",
		heading("OPTIONS"),
		...renderEntries(model.options, width),
		"",
		...wrap(model.guidance, width),
	];
	return `${lines.join("\n")}\n`;
}
