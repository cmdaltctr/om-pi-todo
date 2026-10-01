# Opinionated modular Pi todo system (OMPTS)

A todo extension for Pi with two modes.

- **Normal mode** tracks tasks for one session. It behaves like `@juicesharp/rpiv-todo` 2.11.0.
- **OpenSpec sync mode** shows the tasks of one OpenSpec change. The change's `tasks.md` stays the source of truth. Completing a linked task checks its box.

This package is a local derivative of `@juicesharp/rpiv-todo` 2.11.0 (MIT). See `LICENSE` and `NOTICE.md`.

## Ownership

You own this code. It has no `rpiv-*` dependency. It needs these host packages, listed as wildcard peers in `package.json`: `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` and `typebox`. Pi supplies them. Do not install private copies.

The extension is **not loaded by Pi until you activate it** (see Activation).

## Usage

### Commands

| Command | What it does |
| --- | --- |
| `/todos` | Shows the tasks. In sync mode it also shows the OpenSpec change, freshness, planning readiness and progress. |
| `/todos refresh` | Redraws the panel from committed state. In sync mode it first re-reads the change. It never writes a task file. |
| `/todo-settings` | Sets the session mode, the default mode for new sessions, the panel line budget and the collapse key. |

### Choose a mode

1. Run `/todo-settings`.
2. Pick **Session mode**, then **OpenSpec sync**.
3. Pick a change. The menu shows the planning root. Changes that cannot be bound are listed with a reason.
4. Confirm the root and the change.

Normal mode is the default. Cancelling any step leaves the session as it was.

### Tool calls

The agent uses one tool named `todo`. The examples below are checked by a test against the real tool schema.

Create an ordinary task (normal mode):

```json
{ "action": "create", "subject": "Write tests" }
```

Start work on a linked task (sync mode). `expectedRevision` comes from the latest `list`, `get` or result:

```json
{ "action": "update", "id": 2, "status": "in_progress", "activeForm": "writing tests", "expectedRevision": "0123456789abcdef" }
```

Complete a linked task. The tool writes the checkbox, then asks the OpenSpec CLI to confirm the same task. It reports success only when both succeed:

```json
{ "action": "update", "id": 2, "status": "completed", "expectedRevision": "0123456789abcdef" }
```

Track a temporary step that is not part of the plan:

```json
{ "action": "create", "subject": "Debug flaky test", "scope": "incidental", "reason": "investigating a failure" }
```

Say what a task waits for, then clear it:

```json
{ "action": "update", "id": 2, "waitingReason": "approval from the owner" }
```

```json
{ "action": "update", "id": 2, "waitingReason": "" }
```

### What the panel shows

- The heading counts every task, including completed rows that are hidden. In sync mode it shows `OpenSpec 2/5` and, if you have any, `incidental 1/2`.
- `⚠ stale` or `⚠ unavailable` means the OpenSpec view could not be read. Linked changes are off until a read succeeds. `↻` means a read is running.
- A row shows `Idle` or `Paused` when the agent is not running. It shows `Blocked by #N` while a dependency is unfinished. It never shows a running mark for a stopped agent.
- When all tasks are done and their rows are hidden, the panel shows `all completed (N rows hidden)`.

## Limits

- Sync mode supports `spec-driven` changes with one tracked task file. Other schemas are listed as unsupported.
- Linked wording cannot be changed or deleted through the tool. Revise the OpenSpec plan instead.
- Tasks with identical wording are read-only, because they cannot be matched to one checkbox.
- A checked box records progress. It does not show that tests passed.
- Reopening a completed task is done by editing `tasks.md`. The next refresh shows it.
- A stale lock file (`tasks.md.pi-todo.lock`) is never removed automatically. The error message names the owner. If that process has stopped, delete the file.
- An editor that ignores the lock can still race the final replace of a task file.
- Tested on macOS with Pi 0.99.1 and OpenSpec 1.13.1.

## Panel recovery

If the panel does not draw, or draws old data:

1. Run `/todos refresh`.
2. Read the message. It names the earlier failure when the panel recovers.
3. If it fails again, the message says your tasks are unchanged. Retry after fixing the cause.

A failed redraw never undoes a task change or a checkbox. The tool result also tells the agent when a redraw failed.

If a completion is reported as written but not confirmed, run `/todos refresh`, check `tasks.md`, and do not repeat the completion.

## Activation

Not done yet. The steps below are the plan, and each needs your approval.

1. Back up `~/.pi/agent/settings.json`.
2. Add `"pi": { "extensions": ["./src/extension.ts"] }` to this package's `package.json`.
3. In `packages`, add the absolute path of this directory.
4. Change the original entry `"npm:@juicesharp/rpiv-todo"` to the object form that loads no extension:

```json
{ "source": "npm:@juicesharp/rpiv-todo", "extensions": [] }
```

5. Reload Pi.
6. Check that exactly one `todo` tool exists, and that Pi prints no packaging warning for this package.

## Rollback

1. Remove this directory's path from `packages` in `~/.pi/agent/settings.json`.
2. Restore the original entry:

```json
"npm:@juicesharp/rpiv-todo"
```

3. Reload Pi and check that exactly one `todo` tool exists.

Nothing is deleted. Your task history stays in your sessions. OpenSpec checkboxes that were already written stay written. The preferences file `~/.config/pi-todo/config.json` stays and is ignored by the original package. Rolling back restores basic todo history only, not OpenSpec mode.

## Development

```sh
bun install
./node_modules/.bin/vitest run        # tests
./node_modules/.bin/tsc -p .          # type check
```

`docs/VERIFICATION.md` records the checks, security findings and residual risks.
