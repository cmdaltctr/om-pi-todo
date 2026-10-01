# Architecture Decision Records

This directory records significant architectural decisions made during development.

## Index

| ADR                                                       | Title                                                       | Date       | Status   |
| --------------------------------------------------------- | ----------------------------------------------------------- | ---------- | -------- |
| [001](./001-wrap-long-panel-rows.md)                      | Wrap long panel rows instead of cutting them off            | 2026-10-01 | Accepted |
| [002](./002-keep-task-statuses-current-with-one-nudge.md) | Keep task statuses current with one nudge and a result hint | 2026-10-01 | Accepted |
| [003](./003-show-every-row-with-pi-expand-key.md)         | Show every panel row with Pi's expand key                   | 2026-10-01 | Proposed |
| [004](./004-keep-verification-record-local-only.md)       | Keep the verification record and graph output local only    | 2026-10-01 | Accepted |

## Convention

Each ADR follows this template:

- **Context**: the problem, constraints and forces in play
- **Decision**: what was chosen and why
- **Consequences**: positive, negative and neutral outcomes
- **Alternatives Considered**: options rejected
- **References**: links to relevant files or documentation

ADRs are immutable once the status is "Accepted". A superseded decision gets a "Superseded by ADR-00X" note.

## Creating a new ADR

1. Copy an existing ADR.
2. Number it in sequence with three digits.
3. Set the status to "Proposed".
4. Add a row to the index table.
