// PROTOTYPE — throwaway logic for issue #26.
// Question: can a tiny declarative workflow definition express the current
// Spec/Ticket/Handoff workflow enough to validate legal transitions, required
// inputs/outputs, append-only logs, and GitHub-label current-state projection?

export type IssueId = string;

export type WorkflowIssue = {
  id: IssueId;
  title: string;
  kind: string;
  state: string;
  action: string;
  reason: string | null;
  labels: string[];
  children: IssueId[];
  dependencies: IssueId[];
  changes: string[];
  activeRun: string | null;
};

export type WorkflowLog = {
  seq: number;
  issue: IssueId;
  event: string;
  at: string;
  data: Record<string, unknown>;
};

export type PrototypeState = {
  workflow: string;
  nextIssue: number;
  nextRun: number;
  selected: IssueId | null;
  issues: Record<IssueId, WorkflowIssue>;
  logs: WorkflowLog[];
  lastResult: { ok: true; message: string } | { ok: false; code: string; message: string };
};

type Transition = {
  from: { state: string; action: string };
  to: { state: string; action: string; reason?: string | null };
  event: string;
  requires?: string[];
};

type KindDefinition = {
  initial: { state: string; action: string; reason?: string | null };
  transitions: Transition[];
};

type WorkflowDefinition = {
  name: string;
  reservedLabelPrefix: string;
  kinds: Record<string, KindDefinition>;
};

export const specTicketHandoffWorkflow: WorkflowDefinition = {
  name: "agent-dev",
  reservedLabelPrefix: "awf",
  kinds: {
    spec: {
      initial: { state: "ready", action: "plan", reason: null },
      transitions: [
        {
          event: "start",
          from: { state: "ready", action: "plan" },
          to: { state: "running", action: "plan" },
        },
        {
          event: "succeed",
          from: { state: "running", action: "plan" },
          to: { state: "done", action: "none" },
          requires: ["plan"],
        },
        {
          event: "fail",
          from: { state: "running", action: "plan" },
          to: { state: "ready", action: "plan" },
        },
      ],
    },
    ticket: {
      initial: { state: "ready", action: "implement", reason: null },
      transitions: [
        {
          event: "block",
          from: { state: "ready", action: "implement" },
          to: { state: "blocked", action: "none", reason: "dependencies" },
        },
        {
          event: "unblock",
          from: { state: "blocked", action: "none" },
          to: { state: "ready", action: "implement", reason: null },
        },
        {
          event: "start",
          from: { state: "ready", action: "implement" },
          to: { state: "running", action: "implement" },
        },
        {
          event: "succeed",
          from: { state: "running", action: "implement" },
          to: { state: "ready", action: "review" },
          requires: ["change"],
        },
        {
          event: "start",
          from: { state: "ready", action: "review" },
          to: { state: "running", action: "review" },
        },
        {
          event: "fail",
          from: { state: "running", action: "review" },
          to: { state: "ready", action: "fix" },
        },
        {
          event: "start",
          from: { state: "ready", action: "fix" },
          to: { state: "running", action: "fix" },
        },
        {
          event: "succeed",
          from: { state: "running", action: "fix" },
          to: { state: "ready", action: "review" },
        },
        {
          event: "succeed",
          from: { state: "running", action: "review" },
          to: { state: "ready", action: "integration-test" },
        },
        {
          event: "start",
          from: { state: "ready", action: "integration-test" },
          to: { state: "running", action: "integration-test" },
        },
        {
          event: "fail",
          from: { state: "running", action: "integration-test" },
          to: { state: "ready", action: "integration-test" },
        },
        {
          event: "handoff",
          from: { state: "running", action: "integration-test" },
          to: { state: "need-human", action: "none", reason: "handoff" },
          requires: ["summary"],
        },
        {
          event: "resume",
          from: { state: "need-human", action: "none" },
          to: { state: "ready", action: "integration-test", reason: null },
        },
        {
          event: "succeed",
          from: { state: "running", action: "integration-test" },
          to: { state: "done", action: "none" },
        },
      ],
    },
    handoff: {
      initial: { state: "need-human", action: "none", reason: null },
      transitions: [],
    },
  },
};

export function createInitialState(): PrototypeState {
  const state: PrototypeState = {
    workflow: specTicketHandoffWorkflow.name,
    nextIssue: 1,
    nextRun: 1,
    selected: null,
    issues: {},
    logs: [],
    lastResult: { ok: true, message: "Prototype loaded. Create a spec to begin." },
  };
  createIssue(state, "spec", "Example spec");
  return state;
}

export function createIssue(state: PrototypeState, kind: string, title: string, parent?: IssueId): IssueId {
  const kindDef = specTicketHandoffWorkflow.kinds[kind];
  if (!kindDef) throw new Error(`Unknown kind: ${kind}`);
  const id = String(state.nextIssue++);
  const issue: WorkflowIssue = {
    id,
    title,
    kind,
    state: kindDef.initial.state,
    action: kindDef.initial.action,
    reason: kindDef.initial.reason ?? null,
    labels: [],
    children: [],
    dependencies: [],
    changes: [],
    activeRun: null,
  };
  issue.labels = projectLabels(issue);
  state.issues[id] = issue;
  if (parent) state.issues[parent]?.children.push(id);
  state.selected = id;
  appendLog(state, id, `${kind}_created`, { title, parent });
  state.lastResult = { ok: true, message: `Created ${kind} #${id}` };
  return id;
}

export function applyPlanFixture(state: PrototypeState): void {
  const spec = selectedIssue(state);
  if (!spec || spec.kind !== "spec") return fail(state, "NOT_SPEC", "Select a spec before applying the plan fixture.");
  const api = createIssue(state, "ticket", "Implement API", spec.id);
  const ui = createIssue(state, "ticket", "Implement UI", spec.id);
  state.issues[ui].dependencies.push(api);
  syncBlockedByDependencies(state, ui);
  state.selected = spec.id;
  state.lastResult = { ok: true, message: "Created two tickets; UI starts blocked by API." };
}

export function dispatch(state: PrototypeState, event: string, data: Record<string, unknown> = {}): void {
  const issue = selectedIssue(state);
  if (!issue) return fail(state, "NO_SELECTION", "No issue selected.");
  if (event === "resume") return transition(state, issue, event, data);
  if (event === "handoff") {
    transition(state, issue, event, data);
    if (state.lastResult.ok) createIssue(state, "handoff", `Handoff for ${issue.title}`, issue.id);
    return;
  }
  transition(state, issue, event, data);
  for (const each of Object.keys(state.issues)) syncBlockedByDependencies(state, each);
}

export function selectNext(state: PrototypeState): void {
  const ids = Object.keys(state.issues).sort((a, b) => Number(a) - Number(b));
  const currentIndex = state.selected ? ids.indexOf(state.selected) : -1;
  state.selected = ids[(currentIndex + 1) % ids.length] ?? null;
  state.lastResult = { ok: true, message: `Selected #${state.selected}` };
}

export function projectLabels(issue: WorkflowIssue): string[] {
  const prefix = `${specTicketHandoffWorkflow.reservedLabelPrefix}:${specTicketHandoffWorkflow.name}`;
  return [
    `${prefix}:kind:${issue.kind}`,
    `${prefix}:state:${issue.state}`,
    `${prefix}:action:${issue.action}`,
    ...(issue.reason ? [`${prefix}:reason:${issue.reason}`] : []),
  ];
}

export function readyItems(state: PrototypeState): Array<{ id: IssueId; action: string }> {
  return Object.values(state.issues)
    .filter((issue) => issue.state === "ready" && issue.action !== "none" && dependenciesDone(state, issue))
    .map((issue) => ({ id: issue.id, action: issue.action }));
}

function transition(state: PrototypeState, issue: WorkflowIssue, event: string, data: Record<string, unknown>): void {
  if (issue.activeRun && event === "start") return fail(state, "ACTIVE_RUN", "This issue already has an active run.");
  if (event === "start" && !dependenciesDone(state, issue)) return fail(state, "DEPENDENCY_BLOCKED", "Open dependencies prevent start.");
  const transitions = specTicketHandoffWorkflow.kinds[issue.kind]?.transitions ?? [];
  const transition = transitions.find(
    (candidate) =>
      candidate.event === event && candidate.from.state === issue.state && candidate.from.action === issue.action,
  );
  if (!transition) return fail(state, "ILLEGAL_TRANSITION", `${event} is illegal from ${issue.state}/${issue.action}.`);
  const missing = (transition.requires ?? []).filter((field) => data[field] === undefined || data[field] === "");
  if (missing.length) return fail(state, "MISSING_REQUIRED_INPUT", `Missing required input: ${missing.join(", ")}`);

  const before = { state: issue.state, action: issue.action, reason: issue.reason };
  issue.state = transition.to.state;
  issue.action = transition.to.action;
  issue.reason = transition.to.reason === undefined ? issue.reason : transition.to.reason;
  if (event === "start") issue.activeRun = `r${state.nextRun++}`;
  if (["succeed", "fail", "handoff"].includes(event)) issue.activeRun = null;
  if (typeof data.change === "string") issue.changes.push(data.change);
  issue.labels = projectLabels(issue);
  appendLog(state, issue.id, event, { before, after: { state: issue.state, action: issue.action, reason: issue.reason }, ...data });
  state.lastResult = { ok: true, message: `${event} accepted for #${issue.id}` };
}

function selectedIssue(state: PrototypeState): WorkflowIssue | null {
  return state.selected ? state.issues[state.selected] ?? null : null;
}

function dependenciesDone(state: PrototypeState, issue: WorkflowIssue): boolean {
  return issue.dependencies.every((id) => state.issues[id]?.state === "done");
}

function syncBlockedByDependencies(state: PrototypeState, id: IssueId): void {
  const issue = state.issues[id];
  if (!issue || issue.kind !== "ticket") return;
  const blocked = !dependenciesDone(state, issue);
  if (blocked && issue.state === "ready") {
    issue.state = "blocked";
    issue.action = "none";
    issue.reason = "dependencies";
    issue.labels = projectLabels(issue);
    appendLog(state, id, "auto_blocked", { dependencies: issue.dependencies });
  }
  if (!blocked && issue.state === "blocked" && issue.reason === "dependencies") {
    issue.state = "ready";
    issue.action = "implement";
    issue.reason = null;
    issue.labels = projectLabels(issue);
    appendLog(state, id, "auto_unblocked", { dependencies: issue.dependencies });
  }
}

function appendLog(state: PrototypeState, issue: IssueId, event: string, data: Record<string, unknown>): void {
  state.logs.push({ seq: state.logs.length + 1, issue, event, at: new Date().toISOString(), data });
}

function fail(state: PrototypeState, code: string, message: string): void {
  state.lastResult = { ok: false, code, message };
}
