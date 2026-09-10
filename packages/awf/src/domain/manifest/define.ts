import {
	isPayloadZodSchema,
	workflowManifestStructuralSchema as manifestSchema,
	type ValidationIssue,
	type WorkflowManifest,
	type WorkflowManifestDefinition,
} from "./schema.ts";
export function defineManifest(
	manifest: WorkflowManifestDefinition,
): WorkflowManifest {
	return normalizeManifest(manifest);
}

export function validateManifest(value: unknown): Array<ValidationIssue> {
	const issues: Array<ValidationIssue> = zodValidationIssues(value);

	if (!isRecord(value)) {
		return uniqueIssues([
			...issues,
			{ path: "$", message: "Manifest must be an object." },
		]);
	}

	rejectExecutableData(value, "$", issues);
	rejectHookKeys(value, "$", issues);

	if (value.version !== "v1") {
		issue(issues, "$.version", "Version must be v1.");
	}
	validateIdentifier(value.workflow, "$.workflow", "workflow object", issues);
	if (isRecord(value.workflow)) {
		validateId(value.workflow.id, "$.workflow.id", issues);
		validateSemanticVersion(
			value.workflow.version,
			"$.workflow.version",
			issues,
		);
	}

	const vocabulary = isRecord(value.vocabulary) ? value.vocabulary : undefined;
	if (!vocabulary) {
		issue(issues, "$.vocabulary", "Vocabulary must be an object.");
	}
	const states = readIdentifierSet(
		vocabulary?.states,
		"$.vocabulary.states",
		issues,
	);
	const actions = readIdentifierSet(
		vocabulary?.actions,
		"$.vocabulary.actions",
		issues,
	);
	const events = readIdentifierSet(
		vocabulary?.events,
		"$.vocabulary.events",
		issues,
	);

	validateGithub(value.github, issues);

	const kinds = readArray(value.kinds, "$.kinds", issues);
	const kindIds = new Set<string>();
	const kindActions = new Map<string, Set<string>>();
	const kindSubkinds = new Map<string, Set<string>>();
	for (const [index, kind] of kinds.entries()) {
		const path = `$.kinds[${index}]`;
		if (!isRecord(kind)) {
			issue(issues, path, "Kind must be an object.");
			continue;
		}
		validateUniqueId(kind.id, path, kindIds, issues);
		const localActions = new Set<string>();
		if (typeof kind.id === "string") {
			kindActions.set(kind.id, localActions);
		}
		if (typeof kind.label !== "string" || kind.label === "") {
			issue(issues, `${path}.label`, "Kind label must be a non-empty string.");
		}
		validateStateRef(
			kind.initial,
			`${path}.initial`,
			states,
			actions,
			issues,
			true,
		);
		const localSubkinds = validateSubkinds(
			kind.subkinds,
			`${path}.subkinds`,
			issues,
		);
		if (typeof kind.id === "string") {
			kindSubkinds.set(kind.id, localSubkinds);
		}
		collectStateAction(kind.initial, localActions);
		for (const [transitionIndex, transition] of readArray(
			kind.transitions,
			`${path}.transitions`,
			issues,
		).entries()) {
			validateTransition(
				transition,
				`${path}.transitions[${transitionIndex}]`,
				states,
				actions,
				events,
				issues,
			);
			if (isRecord(transition)) {
				collectStateAction(transition.from, localActions);
				collectStateAction(transition.to, localActions);
			}
		}
	}

	validateConcurrency(value.concurrency, kindIds, kindSubkinds, issues);
	const terminalStates = lifecycleStateSet(value.lifecycle, "terminalStates");
	validateReadiness(
		value.readiness,
		kindIds,
		states,
		actions,
		terminalStates,
		issues,
	);
	validateLifecyclePolicies(value.lifecycle, kindIds, states, actions, issues);

	const commandIds = new Set<string>();
	const commandDeclarations = new Set<string>();
	for (const [index, command] of readArray(
		value.commands,
		"$.commands",
		issues,
	).entries()) {
		validateCommand(
			command,
			`$.commands[${index}]`,
			kindIds,
			states,
			actions,
			events,
			kindActions,
			commandIds,
			commandDeclarations,
			issues,
		);
	}

	for (const [index, relationship] of readArray(
		value.relationships ?? [],
		"$.relationships",
		issues,
	).entries()) {
		validateRelationship(
			relationship,
			`$.relationships[${index}]`,
			kindIds,
			issues,
		);
	}

	return uniqueIssues(issues);
}

function zodValidationIssues(value: unknown): Array<ValidationIssue> {
	const result = manifestSchema.safeParse(value);
	if (result.success) {
		return [];
	}
	return result.error.issues.map((issue) => ({
		path: formatZodPath(issue.path),
		message: issue.message,
	}));
}

function formatZodPath(path: ReadonlyArray<PropertyKey>): string {
	let formatted = "$";
	for (const part of path) {
		if (typeof part === "number") {
			formatted = `${formatted}[${part}]`;
		} else {
			formatted = `${formatted}.${String(part)}`;
		}
	}
	return formatted;
}

function uniqueIssues(issues: Array<ValidationIssue>): Array<ValidationIssue> {
	const seen = new Set<string>();
	return issues.filter((issue) => {
		const key = `${issue.path}\0${issue.message}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

export function normalizeManifest(
	manifest: WorkflowManifestDefinition,
): WorkflowManifest {
	return {
		...manifest,
		github: { reservedPrefix: manifest.github?.reservedPrefix ?? "awf" },
		kinds: manifest.kinds,
		commands: manifest.commands,
	};
}

function validateIdentifier(
	value: unknown,
	path: string,
	noun: string,
	issues: Array<ValidationIssue>,
): void {
	if (!isRecord(value)) {
		issue(issues, path, `${noun} must be an object.`);
	}
}

function validateId(
	value: unknown,
	path: string,
	issues: Array<ValidationIssue>,
): void {
	if (
		typeof value !== "string" ||
		!/^[a-z][a-z0-9-]*$/.test(value) ||
		value === "*"
	) {
		issue(
			issues,
			path,
			"Identifier must use lowercase letters, numbers, and hyphens, and cannot be a wildcard.",
		);
	}
}

function validateUniqueId(
	value: unknown,
	path: string,
	seen: Set<string>,
	issues: Array<ValidationIssue>,
): void {
	validateId(value, `${path}.id`, issues);
	if (typeof value === "string") {
		if (seen.has(value)) {
			issue(issues, `${path}.id`, `Duplicate id '${value}'.`);
		}
		seen.add(value);
	}
}

function validateSemanticVersion(
	value: unknown,
	path: string,
	issues: Array<ValidationIssue>,
): void {
	if (value === undefined) {
		issue(issues, path, "Workflow semantic version is required.");
		return;
	}
	if (
		typeof value !== "string" ||
		!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
			value,
		)
	) {
		issue(issues, path, "Workflow version must be a semantic version.");
	}
}

function validateSubkinds(
	value: unknown,
	path: string,
	issues: Array<ValidationIssue>,
): Set<string> {
	if (value === undefined) {
		return new Set();
	}
	return readIdentifierSet(value, path, issues);
}

function readIdentifierSet(
	value: unknown,
	path: string,
	issues: Array<ValidationIssue>,
): Set<string> {
	const seen = new Set<string>();
	for (const [index, item] of readArray(value, path, issues).entries()) {
		validateId(item, `${path}[${index}]`, issues);
		if (typeof item === "string") {
			if (seen.has(item)) {
				issue(
					issues,
					`${path}[${index}]`,
					`Duplicate vocabulary id '${item}'.`,
				);
			}
			seen.add(item);
		}
	}
	return seen;
}

function validateGithub(value: unknown, issues: Array<ValidationIssue>): void {
	if (value === undefined) {
		return;
	}
	if (!isRecord(value)) {
		issue(issues, "$.github", "GitHub metadata must be an object.");
		return;
	}
	if (
		value.reservedPrefix !== undefined &&
		(typeof value.reservedPrefix !== "string" || value.reservedPrefix === "")
	) {
		issue(
			issues,
			"$.github.reservedPrefix",
			"Reserved prefix must be a non-empty string.",
		);
	}
}

function validateConcurrency(
	value: unknown,
	kindIds: Set<string>,
	kindSubkinds: Map<string, Set<string>>,
	issues: Array<ValidationIssue>,
): void {
	if (!isRecord(value)) {
		issue(issues, "$.concurrency", "Concurrency rules are required.");
		return;
	}
	if (value.perIssue !== 1) {
		issue(
			issues,
			"$.concurrency.perIssue",
			"perIssue concurrency must be exactly 1.",
		);
	}
	if (value.perWorkflow !== undefined) {
		if (
			typeof value.perWorkflow !== "number" ||
			!Number.isInteger(value.perWorkflow) ||
			value.perWorkflow < 1
		) {
			issue(
				issues,
				"$.concurrency.perWorkflow",
				"perWorkflow concurrency must be a positive integer.",
			);
		}
	}
	if (value.perSubkind !== undefined) {
		if (!isRecord(value.perSubkind)) {
			issue(
				issues,
				"$.concurrency.perSubkind",
				"perSubkind concurrency must be an object.",
			);
			return;
		}
		for (const [kind, subkindLimits] of Object.entries(value.perSubkind)) {
			const kindPath = `$.concurrency.perSubkind.${kind}`;
			if (!kindIds.has(kind)) {
				issue(issues, kindPath, "perSubkind kind must reference a known kind.");
			}
			if (!isRecord(subkindLimits)) {
				issue(issues, kindPath, "perSubkind kind limits must be an object.");
				continue;
			}
			const knownSubkinds = kindSubkinds.get(kind) ?? new Set<string>();
			for (const [subkind, limit] of Object.entries(subkindLimits)) {
				const path = `${kindPath}.${subkind}`;
				if (!knownSubkinds.has(subkind)) {
					issue(
						issues,
						path,
						"perSubkind subkind must reference a known subkind.",
					);
				}
				if (
					typeof limit !== "number" ||
					!Number.isInteger(limit) ||
					limit < 1
				) {
					issue(
						issues,
						path,
						"perSubkind concurrency must be a positive integer.",
					);
				}
			}
		}
	}
}

function validateTransition(
	value: unknown,
	path: string,
	states: Set<string>,
	actions: Set<string>,
	events: Set<string>,
	issues: Array<ValidationIssue>,
): void {
	if (!isRecord(value)) {
		issue(issues, path, "Transition must be an object.");
		return;
	}
	validateStateRef(value.from, `${path}.from`, states, actions, issues, false);
	validateStateRef(value.to, `${path}.to`, states, actions, issues, false);
	if (
		typeof value.event !== "string" ||
		!events.has(value.event) ||
		value.event === "*"
	) {
		issue(
			issues,
			`${path}.event`,
			"Transition event must reference a known event and cannot be a wildcard.",
		);
	}
	if (value.input !== undefined) {
		issue(
			issues,
			`${path}.input`,
			"Transition input schemas are not supported.",
		);
	}
}

function validateStateRef(
	value: unknown,
	path: string,
	states: Set<string>,
	actions: Set<string>,
	issues: Array<ValidationIssue>,
	requireAction: boolean,
): void {
	if (!isRecord(value)) {
		issue(issues, path, "State reference must be an object.");
		return;
	}
	if (
		typeof value.state !== "string" ||
		!states.has(value.state) ||
		value.state === "*"
	) {
		issue(
			issues,
			`${path}.state`,
			"State must reference a known state and cannot be a wildcard.",
		);
	}
	if (value.action === undefined) {
		if (requireAction) {
			issue(issues, `${path}.action`, "Action is required.");
		}
	} else if (
		typeof value.action !== "string" ||
		!actions.has(value.action) ||
		value.action === "*"
	) {
		issue(
			issues,
			`${path}.action`,
			"Action must reference a known action and cannot be a wildcard.",
		);
	}
}

function validateReadiness(
	value: unknown,
	kindIds: Set<string>,
	states: Set<string>,
	actions: Set<string>,
	terminalStates: Set<string>,
	issues: Array<ValidationIssue>,
): void {
	if (value === undefined) {
		return;
	}
	if (!isRecord(value)) {
		issue(issues, "$.readiness", "Readiness metadata must be an object.");
		return;
	}
	const filterDeclarations = new Set<string>();
	for (const [index, filter] of readArray(
		value.filters,
		"$.readiness.filters",
		issues,
	).entries()) {
		const path = `$.readiness.filters[${index}]`;
		if (!isRecord(filter)) {
			issue(issues, path, "Readiness filter must be an object.");
			continue;
		}
		if (filter.kind !== undefined && !kindIds.has(String(filter.kind))) {
			issue(issues, `${path}.kind`, "Readiness filter kind must be known.");
		}
		if (filter.state !== undefined && !states.has(String(filter.state))) {
			issue(issues, `${path}.state`, "Readiness filter state must be known.");
		}
		if (
			filter.state !== undefined &&
			terminalStates.has(String(filter.state))
		) {
			issue(
				issues,
				`${path}.state`,
				"Readiness filter state must not be terminal.",
			);
		}
		if (filter.action !== undefined && !actions.has(String(filter.action))) {
			issue(issues, `${path}.action`, "Readiness filter action must be known.");
		}
		const key = [filter.kind, filter.state, filter.action]
			.map((part) => String(part ?? "*"))
			.join("/");
		if (filterDeclarations.has(key)) {
			issue(issues, path, `Duplicate readiness filter declaration '${key}'.`);
		}
		filterDeclarations.add(key);
	}
	const namedFilterNames = new Set<string>();
	for (const [index, filter] of readArray(
		value.namedFilters ?? [],
		"$.readiness.namedFilters",
		issues,
	).entries()) {
		const path = `$.readiness.namedFilters[${index}]`;
		if (!isRecord(filter)) {
			issue(issues, path, "Named readiness filter must be an object.");
			continue;
		}
		validateId(filter.name, `${path}.name`, issues);
		if (typeof filter.name === "string") {
			if (namedFilterNames.has(filter.name)) {
				issue(
					issues,
					`${path}.name`,
					`Duplicate readiness filter name '${filter.name}'.`,
				);
			}
			namedFilterNames.add(filter.name);
		}
		if (typeof filter.kind !== "string" || !kindIds.has(filter.kind)) {
			issue(
				issues,
				`${path}.kind`,
				"Named readiness filter kind must be known.",
			);
		}
		if (filter.relationship !== "parent") {
			issue(
				issues,
				`${path}.relationship`,
				"Named readiness filter relationship must be parent.",
			);
		}
	}
	for (const [index, policy] of readArray(
		value.relationshipPolicies ?? [],
		"$.readiness.relationshipPolicies",
		issues,
	).entries()) {
		const path = `$.readiness.relationshipPolicies[${index}]`;
		if (!isRecord(policy)) {
			issue(issues, path, "Readiness relationship policy must be an object.");
			continue;
		}
		if (policy.relationship !== "children") {
			issue(
				issues,
				`${path}.relationship`,
				"Readiness relationship policy relationship must be children.",
			);
		}
		validateWorkflowFilter(
			policy.where,
			`${path}.where`,
			kindIds,
			states,
			actions,
			issues,
		);
		if (!isRecord(policy.children)) {
			issue(
				issues,
				`${path}.children`,
				"Readiness relationship policy children rule must be an object.",
			);
		} else {
			validateWorkflowFilter(
				policy.children.all,
				`${path}.children.all`,
				kindIds,
				states,
				actions,
				issues,
			);
			validateMinimum(policy.children.min, `${path}.children.min`, issues);
		}
		if (policy.gate !== undefined) {
			validateId(policy.gate, `${path}.gate`, issues);
		}
	}
}

function lifecycleStateSet(
	value: unknown,
	field: "activeStates" | "terminalStates",
): Set<string> {
	if (!isRecord(value)) {
		return new Set();
	}
	const states = value[field];
	if (!Array.isArray(states)) {
		return new Set();
	}
	return new Set(
		states.filter((state): state is string => typeof state === "string"),
	);
}

function validateLifecyclePolicies(
	value: unknown,
	kindIds: Set<string>,
	states: Set<string>,
	actions: Set<string>,
	issues: Array<ValidationIssue>,
): void {
	if (!isRecord(value)) {
		return;
	}
	validateLifecycleStateList(
		value.activeStates,
		"$.lifecycle.activeStates",
		states,
		issues,
	);
	validateLifecycleStateList(
		value.terminalStates,
		"$.lifecycle.terminalStates",
		states,
		issues,
	);
	for (const [index, policy] of readArray(
		value.relationshipPolicies ?? [],
		"$.lifecycle.relationshipPolicies",
		issues,
	).entries()) {
		const path = `$.lifecycle.relationshipPolicies[${index}]`;
		if (!isRecord(policy)) {
			issue(issues, path, "Lifecycle relationship policy must be an object.");
			continue;
		}
		if (policy.relationship !== "parent") {
			issue(
				issues,
				`${path}.relationship`,
				"Lifecycle relationship policy relationship must be parent.",
			);
		}
		validateWorkflowFilter(
			policy.child,
			`${path}.child`,
			kindIds,
			states,
			actions,
			issues,
		);
		validateWorkflowFilter(
			policy.parent,
			`${path}.parent`,
			kindIds,
			states,
			actions,
			issues,
		);
		if (!isRecord(policy.siblings)) {
			issue(
				issues,
				`${path}.siblings`,
				"Lifecycle relationship policy siblings rule must be an object.",
			);
		} else {
			validateWorkflowFilter(
				policy.siblings.all,
				`${path}.siblings.all`,
				kindIds,
				states,
				actions,
				issues,
			);
			validateMinimum(policy.siblings.min, `${path}.siblings.min`, issues);
		}
		validateStateRef(policy.to, `${path}.to`, states, actions, issues, false);
	}
}

function validateLifecycleStateList(
	value: unknown,
	path: string,
	states: Set<string>,
	issues: Array<ValidationIssue>,
): void {
	if (value === undefined) {
		return;
	}
	for (const [index, state] of readArray(value, path, issues).entries()) {
		if (typeof state !== "string" || !states.has(state) || state === "*") {
			issue(
				issues,
				`${path}[${index}]`,
				"Lifecycle state must reference a known state and cannot be a wildcard.",
			);
		}
	}
}

function validateWorkflowFilter(
	value: unknown,
	path: string,
	kindIds: Set<string>,
	states: Set<string>,
	actions: Set<string>,
	issues: Array<ValidationIssue>,
): void {
	if (!isRecord(value)) {
		issue(issues, path, "Workflow filter must be an object.");
		return;
	}
	if (value.kind !== undefined && !kindIds.has(String(value.kind))) {
		issue(issues, `${path}.kind`, "Workflow filter kind must be known.");
	}
	if (value.state !== undefined && !states.has(String(value.state))) {
		issue(issues, `${path}.state`, "Workflow filter state must be known.");
	}
	if (value.action !== undefined && !actions.has(String(value.action))) {
		issue(issues, `${path}.action`, "Workflow filter action must be known.");
	}
}

function validateMinimum(
	value: unknown,
	path: string,
	issues: Array<ValidationIssue>,
): void {
	if (
		value !== undefined &&
		(typeof value !== "number" || !Number.isInteger(value) || value < 0)
	) {
		issue(
			issues,
			path,
			"Relationship policy minimum must be a non-negative integer.",
		);
	}
}

function validateCommand(
	value: unknown,
	path: string,
	kindIds: Set<string>,
	states: Set<string>,
	actions: Set<string>,
	events: Set<string>,
	kindActions: Map<string, Set<string>>,
	commandIds: Set<string>,
	commandDeclarations: Set<string>,
	issues: Array<ValidationIssue>,
): void {
	if (!isRecord(value)) {
		issue(issues, path, "Command must be an object.");
		return;
	}
	validateUniqueId(value.id, path, commandIds, issues);
	if (value.cli !== undefined) {
		if (!isRecord(value.cli)) {
			issue(
				issues,
				`${path}.cli`,
				"Command CLI declaration must be an object.",
			);
		} else {
			validateId(value.cli.verb, `${path}.cli.verb`, issues);
			validateId(value.cli.target, `${path}.cli.target`, issues);
			if (value.cli.verb === "apply") {
				issue(
					issues,
					`${path}.cli.verb`,
					"Generic apply command declarations are not supported.",
				);
			}
			if (value.cli.source !== undefined) {
				issue(
					issues,
					`${path}.cli.source`,
					"Generic source command inputs are not supported.",
				);
			}
			if (
				typeof value.cli.verb === "string" &&
				typeof value.cli.target === "string"
			) {
				const declaration = `${value.cli.verb} ${value.cli.target}`;
				if (commandDeclarations.has(declaration)) {
					issue(
						issues,
						`${path}.cli`,
						`Duplicate command target declaration '${declaration}'.`,
					);
				}
				commandDeclarations.add(declaration);
			}
		}
	}
	if (!isRecord(value.target)) {
		issue(issues, `${path}.target`, "Command target must be an object.");
	} else {
		if (
			typeof value.target.kind !== "string" ||
			!kindIds.has(value.target.kind)
		) {
			issue(
				issues,
				`${path}.target.kind`,
				"Command target kind must reference a known kind.",
			);
		}
		if (
			value.target.state !== undefined &&
			(typeof value.target.state !== "string" ||
				!states.has(value.target.state))
		) {
			issue(
				issues,
				`${path}.target.state`,
				"Command target state must reference a known state.",
			);
		}
		if (value.target.action !== undefined) {
			if (
				typeof value.target.action !== "string" ||
				!actions.has(value.target.action)
			) {
				issue(
					issues,
					`${path}.target.action`,
					"Command target action must reference a known action.",
				);
			} else if (
				typeof value.target.kind === "string" &&
				!kindActions.get(value.target.kind)?.has(value.target.action)
			) {
				issue(
					issues,
					`${path}.target.action`,
					"Command target action must be declared by the target kind's local states or transitions.",
				);
			}
		}
	}
	if (isRecord(value.transition)) {
		if (
			typeof value.transition.event !== "string" ||
			!events.has(value.transition.event)
		) {
			issue(
				issues,
				`${path}.transition.event`,
				"Command transition event must reference a known event.",
			);
		}
		if (
			value.transition.attempt !== undefined &&
			value.transition.attempt !== "none" &&
			value.transition.attempt !== "start" &&
			value.transition.attempt !== "complete"
		) {
			issue(
				issues,
				`${path}.transition.attempt`,
				"Command transition attempt effect must be none, start, or complete.",
			);
		}
	}
	if (value.input !== undefined) {
		validatePayloadZodSchema(value.input, `${path}.input`, issues);
	}
	if (value.output !== undefined) {
		issue(
			issues,
			`${path}.output`,
			"Command output schemas are not supported.",
		);
	}
}

function collectStateAction(value: unknown, actions: Set<string>): void {
	if (
		isRecord(value) &&
		typeof value.action === "string" &&
		value.action !== "*"
	) {
		actions.add(value.action);
	}
}

function validateRelationship(
	value: unknown,
	path: string,
	kindIds: Set<string>,
	issues: Array<ValidationIssue>,
): void {
	if (!isRecord(value)) {
		issue(issues, path, "Relationship must be an object.");
		return;
	}
	validateId(value.id, `${path}.id`, issues);
	if (typeof value.from !== "string" || !kindIds.has(value.from)) {
		issue(issues, `${path}.from`, "Relationship source kind must be known.");
	}
	if (typeof value.to !== "string" || !kindIds.has(value.to)) {
		issue(issues, `${path}.to`, "Relationship target kind must be known.");
	}
	if (!isRecord(value.projection)) {
		issue(
			issues,
			`${path}.projection`,
			"Relationship projection must be an object.",
		);
		return;
	}
	if (
		!["parent-child", "dependency", "generated-by"].includes(
			String(value.projection.type),
		)
	) {
		issue(
			issues,
			`${path}.projection.type`,
			"Relationship projection type must be parent-child, dependency, or generated-by.",
		);
	}
}

function validatePayloadZodSchema(
	value: unknown,
	path: string,
	issues: Array<ValidationIssue>,
): void {
	if (!isPayloadZodSchema(value)) {
		issue(issues, path, "Payload schema must be a Zod schema.");
	}
}

function rejectExecutableData(
	value: unknown,
	path: string,
	issues: Array<ValidationIssue>,
): void {
	if (isPayloadZodSchema(value)) {
		return;
	}
	if (typeof value === "function") {
		issue(
			issues,
			path,
			"Executable hooks are not allowed in workflow manifests.",
		);
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			rejectExecutableData(item, `${path}[${index}]`, issues);
		}
	}
	if (isRecord(value)) {
		for (const [key, item] of Object.entries(value)) {
			rejectExecutableData(item, `${path}.${key}`, issues);
		}
	}
}

function rejectHookKeys(
	value: unknown,
	path: string,
	issues: Array<ValidationIssue>,
): void {
	if (isPayloadZodSchema(value)) {
		return;
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			rejectHookKeys(item, `${path}[${index}]`, issues);
		}
	}
	if (!isRecord(value)) {
		return;
	}
	for (const [key, item] of Object.entries(value)) {
		if (
			["hook", "hooks", "handler", "handlers", "run", "execute"].includes(key)
		) {
			issue(
				issues,
				`${path}.${key}`,
				"Executable hook fields are not part of the declarative v1 schema.",
			);
		}
		rejectHookKeys(item, `${path}.${key}`, issues);
	}
}

function readArray(
	value: unknown,
	path: string,
	issues: Array<ValidationIssue>,
): Array<unknown> {
	if (!Array.isArray(value)) {
		issue(issues, path, "Expected an array.");
		return [];
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
	issues: Array<ValidationIssue>,
	path: string,
	message: string,
): void {
	issues.push({ path, message });
}
