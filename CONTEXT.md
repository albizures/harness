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
