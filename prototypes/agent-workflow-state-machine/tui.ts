#!/usr/bin/env node
// PROTOTYPE — throwaway TUI for issue #26.

import { createInitialState, applyPlanFixture, dispatch, projectLabels, readyItems, selectNext } from "./workflow-machine.ts";

const bold = "\x1b[1m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";
const red = "\x1b[31m";
const green = "\x1b[32m";

const state = createInitialState();

function render() {
  console.clear();
  const selected = state.selected ? state.issues[state.selected] : null;
  console.log(`${bold}Manifest-driven workflow state-machine prototype${reset}`);
  console.log(`${dim}Question: can a tiny declarative manifest validate transitions, required payloads, append-only logs, and GitHub-label projection?${reset}\n`);

  console.log(`${bold}Selected issue${reset}`);
  if (selected) {
    console.log(JSON.stringify(selected, null, 2));
    console.log(`${dim}Projected labels:${reset}`);
    for (const label of projectLabels(selected)) console.log(`  ${label}`);
  } else {
    console.log("none");
  }

  console.log(`\n${bold}Ready items${reset}`);
  console.log(JSON.stringify(readyItems(state), null, 2));

  console.log(`\n${bold}All issues${reset}`);
  for (const issue of Object.values(state.issues)) {
    const marker = issue.id === state.selected ? "→" : " ";
    console.log(`${marker} #${issue.id} ${issue.kind} ${issue.state}/${issue.action}${issue.reason ? ` reason=${issue.reason}` : ""} ${dim}${issue.title}${reset}`);
  }

  console.log(`\n${bold}Append-only log tail${reset}`);
  for (const log of state.logs.slice(-8)) {
    console.log(`#${log.seq} issue=${log.issue} event=${log.event} ${dim}${JSON.stringify(log.data)}${reset}`);
  }

  const result = state.lastResult;
  const color = result.ok ? green : red;
  console.log(`\n${color}${bold}${result.ok ? "OK" : result.code}${reset} ${result.message}`);

  console.log(`\n${bold}Keys${reset}`);
  console.log(`[n] next issue   [p] apply plan fixture   [s] start   [w] succeed   [f] fail`);
  console.log(`[h] handoff      [r] resume human-blocked   [x] succeed-without-change probe   [q] quit`);
}

function handle(key: string) {
  if (key === "n") selectNext(state);
  if (key === "p") applyPlanFixture(state);
  if (key === "s") dispatch(state, "start");
  if (key === "w") {
    const issue = state.selected ? state.issues[state.selected] : null;
    const payload = issue?.action === "implement" ? { change: `pr-${issue.id}` } : issue?.action === "plan" ? { plan: "fixture" } : {};
    dispatch(state, "succeed", payload);
  }
  if (key === "f") dispatch(state, "fail");
  if (key === "h") dispatch(state, "handoff", { summary: "prototype handoff evidence" });
  if (key === "r") dispatch(state, "resume");
  if (key === "x") dispatch(state, "succeed");
}

render();
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (key) => {
  if (key === "q" || key === "\u0003") {
    process.stdin.setRawMode(false);
    process.exit(0);
  }
  handle(key);
  render();
});
