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
A skill group for meta-skills that help users coordinate agent sessions, choose agent flows, or transform work artifacts so agents can operate more effectively.
_Avoid_: engineering skill group, design skill group, miscellaneous skill group
