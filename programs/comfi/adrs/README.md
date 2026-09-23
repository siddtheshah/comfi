# Architecture Decision Records (ADRs)

This directory documents the architectural and design decisions for the ComFi Anchor smart contract program (`programs/comfi`).

## Purpose

Architecture Decision Records (ADRs) capture important architectural decisions along with their context, rationale, trade-offs, and consequences. They serve as the source of truth for protocol design, threat models, economic mechanisms, and security invariants.

## Status Lifecycle

- **Proposed**: Under review and community/developer discussion.
- **Accepted**: Approved and scheduled for or actively implemented in code.
- **Implemented**: Merged and verified in the program codebase with unit and integration tests.
- **Superseded**: Replaced by a subsequent ADR (referenced).
- **Deprecated**: Abandoned or removed from the protocol.

## Index of Records

| ADR | Title | Status | Date |
| --- | --- | --- | --- |
| [0001](0001-fair-closure-algorithm.md) | Fair Closure Algorithm | Implemented | 2026-09-23 |

## ADR Template

New ADRs should follow this structure:

```markdown
# ADR [Number]: [Title]

## Status
[Proposed | Accepted | Implemented | Deprecated | Superseded by ADR-XXXX]

## Context and Problem Statement
What is the problem being solved? What forces, constraints, or threat models apply?

## Decision Drivers
What factors influence this decision (e.g. security invariants, Solana compute unit limits, UX)?

## Considered Options
What alternatives were evaluated?

## Decision Outcome
What option was chosen and what is the detailed technical specification?

## Threat Model and Attack Mitigations
How does this decision protect against adversarial behavior (e.g. 51% attacks, front-running)?

## Invariants and Properties
What mathematical and state invariants must hold?

## Consequences
- **Positive**: Advantages gained.
- **Negative / Trade-offs**: Complexities introduced.

## Implementation & Test References
Links to source files and unit tests validating the decision.
```
