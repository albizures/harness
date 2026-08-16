# Units of Reasoning: A Recursive Model for Building Codebases

## Motivation

Most software architecture describes systems using different concepts at different scales.

```text
Application
└── Service
    └── Module
        └── Class
            └── Function
```

Each level introduces a different abstraction with its own terminology and design principles. As a result, reasoning about architecture often requires changing mental models as we move through the system.

This proposal instead treats the entire codebase as a hierarchy of **Units of Reasoning**. Regardless of scale, every part of the system is described using the same conceptual model.

Rather than asking *what language construct is this?*, the focus becomes *what concept does this represent, and what does it guarantee?*

The objective is not decomposition for its own sake. The objective is to organize software so that each part can be understood, implemented, tested, and evolved through **independent reasoning**.

Every refinement should reduce the amount of the system that must be understood at once.

---

# Unit of Reasoning

A **Unit of Reasoning** is the largest coherent concept that can be understood through its purpose and contract without requiring knowledge of its internal implementation.

The identity of a Unit of Reasoning is defined by two things:

* **Purpose** — Why the unit exists.
* **Contract** — What the unit guarantees to the outside world.

Everything else is an implementation detail.

Every Unit of Reasoning also has:

* **Implementation** — How the contract is fulfilled.
* **Children (optional)** — Smaller Units of Reasoning used to realize the implementation.

A consumer should depend only on the unit's purpose and contract, never on its implementation.

---

# Recursive Hierarchy

A codebase is a recursive hierarchy of Units of Reasoning.

```text
Application
├── Authentication
│   ├── Login
│   ├── Session
│   └── Authorization
│
├── Checkout
│   ├── Pricing
│   ├── Payment
│   ├── Inventory
│   └── Notifications
│
└── Administration
```

Each child is itself another Unit of Reasoning.

The same conceptual model applies uniformly at every level of the hierarchy, from the application itself down to the smallest implementation detail.

---

# Parent and Child Units

The existence of child units does **not** invalidate the parent as a Unit of Reasoning.

For example:

```text
Checkout
├── Pricing
├── Payment
└── Inventory
```

"Checkout" remains a complete architectural concept with its own purpose and contract.

The child units are not alternative ways of reasoning about Checkout; they are part of its implementation.

Depending on the task, reasoning may occur at the Checkout level or at one of its child units, but the parent remains an independent Unit of Reasoning regardless of its internal structure.

---

# Refinement

Software architecture evolves through **refinement**.

Refinement is the process of replacing part of a Unit of Reasoning's implementation with child Units of Reasoning that each expose their own purpose and contract while collectively realize the parent's implementation.

The guiding question is not:

> Can I still reason about this as one concept?

A parent can remain a meaningful concept regardless of how many child units it contains.

Instead, the question is:

> **Can this unit be meaningfully refined into child Units of Reasoning?**

A refinement is **meaningful** when it reveals one or more independent concepts that contribute to realizing the parent's contract, where each concept has its own purpose and contract.

The goal of refinement is not to create more units.

The goal is to introduce reasoning boundaries that allow both humans and AI agents to understand less of the system at a time.

A meaningful refinement should therefore reduce the amount of knowledge required to understand the parent's implementation.

Children should exist because they reveal concepts—not because the parent has become large or because a particular programming language encourages additional abstraction.

Refinement preserves the identity of the parent while revealing additional concepts within its implementation.

---

# Design Process

Designing a codebase is the recursive process of refining Units of Reasoning.

For every unit:

1. Define its purpose.
2. Define its contract.
3. Determine whether it can be meaningfully refined.
4. If so, define its child Units of Reasoning.
5. Repeat recursively for every child.
6. Implement the unit using its children.

Implementation follows architectural refinement—not the other way around.

---

# Leaf Units

A **Leaf Unit of Reasoning** is one whose implementation cannot be meaningfully refined further.

In practice, a leaf is often a function, but it is not limited to functions.

Possible leaf units include:

* Function
* State machine
* SQL query
* Parser
* Value object
* Regular expression

The stopping criterion is conceptual rather than syntactic.

---

# Contracts

Contracts enable independent reasoning.

A consumer of a Unit of Reasoning should rely only on its contract—not on how the contract is implemented.

Once a consumer trusts a contract, it should be able to stop reasoning about the unit's internal implementation.

Changing an implementation while preserving its contract should not affect other Units of Reasoning.

This naturally improves:

* Replaceability
* Testability
* Parallel development
* AI agent ownership
* Human comprehension

These are consequences of well-defined reasoning boundaries rather than goals in themselves.

---

# Non-Goals

A Unit of Reasoning is a conceptual construct, not a programming construct.

It does not necessarily correspond to a package, module, class, file, or function.

Different programming languages may represent the same Unit of Reasoning using different language features.

Likewise, a single package may contain multiple Units of Reasoning, and a single Unit of Reasoning may span multiple source files.

The methodology defines how to reason about software, not how source code must be organized.

---

# Architectural Principle

Software architecture is the process of organizing a system into a hierarchy of Units of Reasoning.

Each Unit of Reasoning exposes a clear purpose and contract while hiding the details of its implementation.

Refinement is the mechanism through which this hierarchy is discovered, allowing increasingly detailed concepts to emerge while preserving the identity and boundaries of their parents.

The objective of this hierarchy is to maximize independent reasoning.

At every level, a developer or AI agent should be able to understand only the Units of Reasoning relevant to the current task, relying on the contracts of all others without needing to understand their implementations.

The resulting architecture forms a recursive hierarchy in which every node—from the entire application to the smallest leaf—is described using the same conceptual model.

---

# Future Work

This document defines the structural model only.

Future documents should define:

* Practical heuristics for identifying meaningful refinements.
* Heuristics for deciding when to stop refining.
* Relationships between Units of Reasoning and language constructs.
* How Units of Reasoning map to AI agent ownership.
* Visualization of the hierarchy as a graph or tree.
* Practical examples of designing a codebase using this methodology.
