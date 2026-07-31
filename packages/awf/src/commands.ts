import { type Envelope, failure, success } from "./envelope.ts";

type CommandSpec = {
  name: string;
  usage: string;
  description: string;
};

const commands: CommandSpec[] = [
  { name: "get", usage: "awf get <id>", description: "Return a workflow entity." },
  { name: "ready", usage: "awf ready [--spec <id>]", description: "Return legally executable work." },
  { name: "logs", usage: "awf logs <id>", description: "Return immutable workflow logs." },
  { name: "spec create", usage: "awf spec create --title <title> --content <file>", description: "Create a Spec." },
  { name: "plan apply", usage: "awf plan apply <spec> --input <plan.json>", description: "Apply a plan to a Spec." },
  { name: "handoff", usage: "awf handoff <source> --input <handoff.json>", description: "Create a Handoff." },
  { name: "start", usage: "awf start <id>", description: "Start the current action." },
  { name: "succeed", usage: "awf succeed <id> --run <run>", description: "Mark a run as succeeded." },
  { name: "fail", usage: "awf fail <id> --run <run>", description: "Mark a run as failed." },
];

export function execute(args: string[]): Envelope {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return success({
      name: "awf",
      description: "Agent workflow CLI.",
      commands,
    });
  }

  if (args[0] === "--version" || args[0] === "-v") {
    return success({ name: "@albizures/awf", version: "0.0.0" });
  }

  const parseError = validateKnownCommand(args);
  if (parseError !== undefined) {
    return parseError;
  }

  return failure("NOT_IMPLEMENTED", "This workflow command is not implemented yet.", {
    command: args.join(" "),
  });
}

function validateKnownCommand(args: string[]): Envelope | undefined {
  const [command, subcommand] = args;

  switch (command) {
    case "get":
    case "logs":
    case "start":
      return requirePositionalCount(args, 1, `awf ${command} <id>`);
    case "ready":
      return validateReady(args);
    case "handoff":
      return requirePositionalAndOption(args, "awf handoff <source> --input <handoff.json>", "--input");
    case "succeed":
    case "fail":
      return requirePositionalAndOption(args, `awf ${command} <id> --run <run>`, "--run");
    case "spec":
      if (subcommand !== "create") {
        return unknownCommand(args);
      }
      return requireOptions(args, "awf spec create --title <title> --content <file>", ["--title", "--content"]);
    case "plan":
      if (subcommand !== "apply") {
        return unknownCommand(args);
      }
      return requirePositionalAndOption(args, "awf plan apply <spec> --input <plan.json>", "--input", 2);
    default:
      return unknownCommand(args);
  }
}

function validateReady(args: string[]): Envelope | undefined {
  if (args.length === 1) {
    return undefined;
  }
  if (args.length === 3 && args[1] === "--spec" && args[2] !== "") {
    return undefined;
  }
  return failure("INVALID_ARGUMENTS", "Invalid arguments for ready.", { usage: "awf ready [--spec <id>]" });
}

function requirePositionalCount(args: string[], count: number, usage: string): Envelope | undefined {
  const positionals = args.slice(1).filter((arg) => !arg.startsWith("-"));
  if (positionals.length === count && args.length === count + 1) {
    return undefined;
  }
  
  return failure("INVALID_ARGUMENTS", "Invalid command arguments.", { usage });
}

function requirePositionalAndOption(
  args: string[],
  usage: string,
  optionName: string,
  prefixPositionals = 1,
): Envelope | undefined {
  const prefix = args.slice(1, 1 + prefixPositionals);
  const optionIndex = args.indexOf(optionName);
  if (
    prefix.every((arg) => arg !== undefined && arg !== "" && !arg.startsWith("-")) &&
    optionIndex === 1 + prefixPositionals &&
    args[optionIndex + 1] !== undefined &&
    args[optionIndex + 1] !== "" &&
    args.length === optionIndex + 2
  ) {
    return undefined;
  }

  return failure("INVALID_ARGUMENTS", "Invalid command arguments.", { usage });
}

function requireOptions(args: string[], usage: string, optionNames: string[]): Envelope | undefined {
  if (args.length !== 2 + optionNames.length * 2) {
    return failure("INVALID_ARGUMENTS", "Invalid command arguments.", { usage });
  }

  for (const optionName of optionNames) {
    const optionIndex = args.indexOf(optionName);
    if (optionIndex === -1 || args[optionIndex + 1] === undefined || args[optionIndex + 1] === "") {
      return failure("INVALID_ARGUMENTS", "Invalid command arguments.", { usage });
    }
  }

  return undefined;
}

function unknownCommand(args: string[]): Envelope {
  return failure("UNKNOWN_COMMAND", "Unknown command.", { command: args.join(" ") });
}
