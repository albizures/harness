# Harness

Harness is a collection of small Pi packages maintained in this repository.

## Language

**Pi package**:
A distributable unit that bundles Pi resources such as extensions, skills, prompts, or themes for installation through Pi.
_Avoid_: plugin, add-on

**Pi extension**:
A Pi resource that registers behavior with Pi, such as commands, tools, or event handlers.
_Avoid_: plugin

**Tiny package**:
A Pi package with one narrow behavior and minimal surface area. It should avoid configuration, UI, and extra abstractions unless they are required for that behavior.
_Avoid_: framework, toolkit

**Pi footer**:
The bottom UI surface in Pi used for status and session information.
_Avoid_: bottom bar, status bar

**Project-local dev shim**:
A committed project-local Pi extension under `.pi/extensions/` that loads package source resources from the workspace for development smoke testing, such as source extensions or source skill directories.
_Avoid_: test package, local install

**Context fill bar**:
A visual indicator in the Pi footer that shows how much of the active model's context window is currently occupied.
_Avoid_: filling bar, progress bar, token bar

**Context attribution estimate**:
An approximate breakdown of the active Pi session's context usage by source, such as system prompt inputs, skills, context files, conversation messages, and tool results. It is diagnostic rather than provider-exact accounting.
_Avoid_: exact token accounting, billing attribution

**Context Inspector**:
A Pi extension that displays a command-opened, read-only context attribution estimate for the current active Pi context.
_Avoid_: context analyzer, context accounting

**Active context snapshot**:
A point-in-time view of the current active Pi context, even if Pi is still streaming or running tools. It may change after the current turn settles.
_Avoid_: settled context report, final context report

**Context bucket**:
A user-facing source category in a context attribution estimate, such as Tool definitions, Context files, or Tool results.
_Avoid_: token class, accounting category

**Context contributor**:
A named item within a context bucket that materially contributes to the bucket's estimated size. It is shown by name and estimate only, not by raw content excerpt.
_Avoid_: snippet, sample, payload

**Overlay frame**:
A command-scoped visual border around a modal TUI overlay. It clarifies overlay boundaries without creating persistent UI or adding actions.
_Avoid_: widget, panel, footer, action bar

**Release**:
A repository-level delivery event that assigns package versions and makes one or more changed Pi packages available.
_Avoid_: publish

**Publish**:
The act of uploading one Pi package version to the package registry.
_Avoid_: release

**Package version**:
The version owned by an individual Pi package. Harness packages are versioned independently rather than sharing one repository-wide version.
_Avoid_: repo version, lockstep version

**Releasable change**:
A change that affects the installed behavior, public metadata, or compatibility of a published Pi package, and therefore requires a changeset.
_Avoid_: any change, internal change

**Release PR**:
An automated pull request that applies pending changesets by updating package versions and changelogs before publishing.
_Avoid_: manual version bump, publish PR

**Changeset guard**:
A pull request check that requires package-area changes to carry a pending changeset unless the pull request is explicitly exempt from release planning.
_Avoid_: release check, version check

**Suggested Replies**:
A Pi package feature that lets the agent present ephemeral reply suggestions that the user can insert into the normal prompt editor as a fast answer.
_Avoid_: question tool, options selector, choice prompt

**Skill catalog**:
A root-level `skills/` directory whose subdirectories organize installable Agent Skills for `npx skills add`. Harness uses a skill catalog as the source of truth for shared skills rather than npm skill packages.
_Avoid_: skill npm package, package source, `.agents/skills` source

**Skill group**:
A category inside the skill catalog that groups related skills by user outcome, such as engineering or design. Skill groups are catalog organization, not npm package boundaries.
_Avoid_: skill package, category package, bundle
