# ADR-002: Keep task statuses current with one nudge and a result hint

- **Date:** 2026-10-01
- **Status:** Accepted
- **Deciders:** Dr Muhammad Aizat Bin Md Hawari

## Context

The agent sometimes forgets to update a task. A task stays `in_progress` after the work stops, or the next task starts without a status change.
The prompt guidelines already ask for updates, and the agent ignored them.
The only end-of-run check was a reminder to the user on `agent_settled`. That event is notification-only and cannot reach the agent.

## Decision

Two signals reach the agent. Neither one changes a task.

1. **One nudge before the run settles.** The extension handles Pi's `agent_before_settle` event.
   - It acts when a task is `in_progress` and has no `waitingReason` or `failureReason`.
   - It returns one `custom_message` entry and `continue: true`, so the agent takes one more turn.
   - It acts once for each prompt. A new `before_agent_start` event resets the limit.
   - It does nothing when the run was aborted or ended in an error, because the user stopped it.
2. **A hint on the result.** A `todo` result for `update` to `completed`, or for `delete`, ends with a hint.
   - It appears only when no task is `in_progress` and some are `pending`.
   - A move back to `pending` gets no hint, because the agent chose it.
3. **A guideline.** The prompt guidelines tell the agent to match every status to reality before it ends a turn.

The agent changes the task. The extension never marks a task complete and never ticks a box.

## Consequences

### Positive

- A forgotten status gets one chance to be fixed before the user sees a stale panel.
- A task that explains its wait is left alone.
- Tests and a real Pi run confirmed one nudge, no nudge after an abort, and an unchanged `tasks.md` in sync mode.

### Negative

- The nudge costs one extra model turn when it fires.
- If another extension also continues at `agent_before_settle`, Pi may honour only one of them. This is untested.

### Neutral

- The existing reminder to the user on `agent_settled` stays.

## Alternatives Considered

| Option                                     | Rejected Because                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| **Stronger prompt wording only**           | The agent already ignored the current wording.                             |
| **`sendUserMessage` after the run ends**   | It starts a new run and shows as a user message. Pi offers a better route. |
| **Add task state to every turn's context** | It costs tokens on every turn, not only when a status is stale.            |
| **Mark the task done for the agent**       | A checked box must come from the agent. A guess would be wrong.            |

## References

- `src/reminder.ts`, `src/extension.ts`, `src/todo.ts`
- `test/status-nudge.test.ts`
- `docs/USAGE.md`, section "Keeping statuses current"
- Commits `24c6031` and `c31bc07`
