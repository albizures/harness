# Harness skills

This directory is the source of truth for shared/installable Agent Skills in this repository.

Install from GitHub with:

```sh
npx skills add albizures/harness
```

List available skills first:

```sh
npx skills add albizures/harness --list
```

Install a specific skill by name:

```sh
npx skills add albizures/harness --skill <skill-name>
```

Skills are organized as:

```txt
skills/<group>/<skill-name>/SKILL.md
```

Current groups:

- `engineering/` — engineering workflow skills
- `design/` — design and modeling skills
- `workflow/` — meta-skills that help users coordinate agent sessions, choose agent flows, or transform work artifacts so agents can operate more effectively

The legacy `.agents/skills/` tree is not the source of truth for this catalog and should not be used for new shared skills.
