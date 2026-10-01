# ADR-001: Wrap long panel rows instead of cutting them off

- **Date:** 2026-10-01
- **Status:** Accepted
- **Deciders:** Dr Muhammad Aizat Bin Md Hawari

## Context

The todo panel cut every row to the terminal width and ended it with `…`.
A row that carries a `waiting:` or `failed:` reason is often longer than the width.
The reason is the part the user needs, and it was the part that disappeared.
A real session showed `waiting: Waiting requested OCR review and…` and the rest was lost.

## Decision

A long row wraps onto extra lines under its own tree connector.

1. The first line keeps its `├─` or `└─` connector.
2. Each continuation line starts with `│` and two spaces, so it stays under its row.
3. The last row closes the tree with `└─` only when no summary row follows.
4. Wrapping uses `wrapTextWithAnsi` from `pi-tui`, so colour codes stay intact.
5. The heading and summary rows still use `truncateToWidth`. They are short and fixed.

The line budget still counts tasks, not screen lines.

## Consequences

### Positive

- A waiting or failure reason is always readable in full.
- No line is wider than the terminal.

### Negative

- Ten long tasks can take more than the configured line budget on screen.
- The row text uses three fewer columns for the connector.

### Neutral

- The `/todos` command and the tool text are unchanged. They never truncated.

## Alternatives Considered

| Option                               | Rejected Because                                                |
| ------------------------------------ | --------------------------------------------------------------- |
| **Keep truncating**                  | It hides the waiting reason, which is the most useful part.     |
| **Shorten the reason text**          | The agent writes the reason. Shortening it changes its meaning. |
| **Count screen lines in the budget** | It needs a second layout pass. No requirement asks for it yet.  |
| **Show the reason on its own row**   | It doubles the row count for every task with a reason.          |

## References

- `src/todo-overlay.ts`, method `renderWidget`
- `test/overlay.test.ts`, group "a long row wraps instead of being cut off"
- Commit `72f9d96`
