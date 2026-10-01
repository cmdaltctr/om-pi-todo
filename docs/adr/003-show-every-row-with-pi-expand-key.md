# ADR-003: Show every panel row with Pi's expand key

- **Date:** 2026-10-01
- **Status:** Proposed
- **Deciders:** Dr Muhammad Aizat Bin Md Hawari

## Context

The panel hides done rows from earlier turns and rows beyond the line budget.
The summary row said `+12 more (12 completed hidden)` and gave no way to see them.
The user asked for a key to show them, or for no hiding at all.

## Decision

The summary row names a key, and the key shows every row.

1. The text is `· ctrl+o to show all`. It is added to the `+N more` row and to the `all completed` row.
2. `ctrl+o` is Pi's own key for expanding tool output. The panel already read `getToolsExpanded()` on every render, so no new shortcut is registered.
3. When Pi's expanded mode is on, the panel shows every task, including done rows hidden on earlier turns, and ignores the line budget.
4. A second press returns to the normal view.
5. `ctrl+e` is not used. Pi binds it to "move to line end" in the editor.

Hiding stays on by default. A long list would otherwise take over the screen.

## Consequences

### Positive

- One key shows everything. No new setting and no new shortcut.
- The key already works for Pi users who know it.

### Negative

- The hint text is fixed at `ctrl+o`. Pi gives a panel no way to ask which key is bound, so the hint is wrong if the user rebinds Pi's expand key.
- The key also expands tool output. The user cannot show panel rows alone.

### Neutral

- The collapse key for the panel (`ctrl+shift+t` by default) is unchanged.

## Alternatives Considered

| Option                              | Rejected Because                                                      |
| ----------------------------------- | --------------------------------------------------------------------- |
| **Never hide rows**                 | A long list takes over the screen above the editor.                   |
| **A new shortcut such as `ctrl+e`** | It clashes with Pi's editor binding.                                  |
| **A new setting for hiding**        | No requirement asks for it. `AGENTS.md` forbids unrequested settings. |
| **Read the key from Pi**            | The extension API does not expose it to a widget.                     |

## References

- `src/todo-overlay.ts`, method `renderWidget`
- `test/overlay.test.ts`, group "hidden rows can always be shown"
- `docs/USAGE.md`, section "Show every row"
- Commit `9fac056`
- Status stays Proposed until the keypress is checked in a live interactive Pi session. Tests fake the expanded flag.
