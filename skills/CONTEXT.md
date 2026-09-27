# Skills

The Skills context describes the shared skill catalog maintained under the root `skills/` directory.

## Language

**Skill catalog**:
A root-level `skills/` directory whose subdirectories organize installable Agent Skills for `npx skills add`. Harness uses a skill catalog as the source of truth for shared skills rather than npm skill packages.
_Avoid_: skill npm package, package source, `.agents/skills` source

**Skill group**:
A category inside the skill catalog that groups related skills by user outcome, such as engineering or design. Skill groups are catalog organization, not npm package boundaries.
_Avoid_: skill package, category package, bundle

**Workflow skill group**:
A skill group for meta-skills that help users coordinate agent sessions, choose agent flows, operate Forge workflow records, or transform work artifacts so agents can operate more effectively.
_Avoid_: engineering skill group, design skill group, miscellaneous skill group

**Forge reference**:
The canonical skill document that defines how agents operate Forge Specs, Tasks, Wayfinders, Grilling, initiatives, dependencies, readiness, lifecycle, comments, and history through public Forge CLI behavior.
_Avoid_: duplicated Forge command table, local workflow schema reference

**Orchestration skill**:
A user-facing workflow skill that routes a user intent to narrower skills or Forge operations without duplicating their detailed procedures.
_Avoid_: wrapper skill, duplicate skill

**Transformation primitive**:
A narrow skill that converts one work artifact into another, such as conversation context into a Forge Spec or an approved plan into Forge Tasks.
_Avoid_: orchestration skill, workflow umbrella
