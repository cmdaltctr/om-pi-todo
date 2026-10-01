# How to use

This guide shows how to use the todo list, in both modes.

## The three commands

| Command          | What it does                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `/todos`         | Shows your tasks. In sync mode it also shows the OpenSpec change and its progress.             |
| `/todos refresh` | Redraws the panel. In sync mode it reads the change again first. It never changes a task file. |
| `/todo-settings` | Opens the settings menu.                                                                       |

## Normal mode

Normal mode is the default. You do nothing. The agent adds tasks with the `todo` tool, and the panel above the editor shows them.

- The agent marks a task `in_progress` before it starts, and `completed` when it finishes.
- A task can wait on another task. Such a task shows `Blocked by #N` until the other one is done.
- The agent can say why a task waits (`waitingReason`) or failed (`failureReason`). The panel shows both.

## OpenSpec sync mode

Sync mode ties the list to one OpenSpec change. The change's `tasks.md` file holds the task wording and which boxes are ticked.

### Turn it on

1. Start Pi in the project that holds your `openspec/changes/` folder.
2. Run `/todo-settings`.
3. Press Enter on the first row, **Session mode**. It shows your current mode.
4. Choose **OpenSpec sync**.
5. Choose a change from the list. Each change that cannot be used shows the reason.
6. Check the planning root shown in the dialog, then confirm.
7. Run `/todos`. It shows the change, the word `fresh`, and the tasks.

Only this session changes. Your other Pi sessions keep their own mode.

### What the agent does

The agent works from the task list that `/todos` shows. It uses the task numbers it sees there.

- To start a task, it sets `in_progress`. This changes nothing in the file.
- To finish a task, it sets `completed`. The extension then:
  1. writes `[x]` in the one matching line of `tasks.md`,
  2. asks OpenSpec to read the file again,
  3. reports success only when OpenSpec shows that same task as done.
- If any step fails, the task stays open and the agent gets a clear error.

The agent must send the file's current revision with every status change. If you edit `tasks.md` in between, the call fails and the agent reads the list again. This stops it ticking the wrong box.

### Temporary steps

Sometimes the agent needs a small task that is not in the plan, such as "debug a failing test". It must mark such a task as `incidental` and give a reason. These tasks show in a separate count. They never change the OpenSpec numbers.

### Turn it off

1. Run `/todo-settings`.
2. Choose **Session mode**, then **Normal**.

Your normal task list comes back. `tasks.md` is not changed.

## Reading the panel

The panel sits above the editor. Its heading shows progress.

- Normal mode: `Todos (2/5)` means 2 of 5 tasks are done.
- Sync mode: `Todos · OpenSpec 2/5 · incidental 1/2` keeps the two counts apart.

Marks on the heading and rows:

| You see                                              | It means                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `⚠ stale` or `⚠ unavailable`                         | The OpenSpec view could not be read. Linked changes are off until it can.        |
| `↻`                                                  | A read is running. You see the last good view meanwhile.                         |
| `Idle`                                               | The agent finished its turn. The task is still open.                             |
| `Paused`                                             | You stopped the agent, or it hit an error. The task is still open.               |
| `Blocked by #3`                                      | Task 3 must finish first.                                                        |
| `waiting: …` and `failed: …`                         | The reasons the agent gave.                                                      |
| `+2 more (2 completed hidden) · ctrl+o to show all`  | Rows are hidden. The count still includes them. Press the key to show every row. |
| `all completed (5 rows hidden) · ctrl+o to show all` | Every task is done. Press the key to show them.                                  |

A long row wraps onto the next lines under its own mark. Nothing is cut off.

### Show every row

The panel hides done rows from earlier turns and rows beyond the line budget. The last row says how many are hidden and names the key.

1. Press `ctrl+o`. This is Pi's key for expanding tool output. The panel shows every row, including done ones.
2. Press `ctrl+o` again to hide them.

If you changed Pi's expand key, use your key. The hint text still says `ctrl+o`. Do not use `ctrl+e`: Pi uses it to move to the end of a line in the editor.

## Keeping statuses current

The agent sometimes forgets to update a task. Two things help.

1. **A hint on the result.** After a call that completes or deletes a task, the result says so when no task is `in_progress` and some are still `pending`. The agent sees the hint and marks the next task.
2. **One nudge before it stops.** When the agent finishes a turn and a task is still `in_progress` with no `waitingReason` or `failureReason`, the extension sends the agent one message. The message lists those tasks and asks the agent to update each one. The agent then takes one more turn. You see the message in the transcript.

The nudge:

- Comes once for each prompt you send.
- Does not come after you stop the agent, or after an error.
- Skips a task that gives a `waitingReason` or a `failureReason`.
- Never changes a task and never ticks a box. The agent does that.

When the agent stops with work still open, you also get one reminder that lists the open tasks.

## Settings

Run `/todo-settings` to change:

- **Session mode**: Normal or OpenSpec sync, for this session.
- **Default mode for new sessions**: what new sessions start in. Sync still waits for you to pick a change.
- **Panel line budget**: how many rows the panel may use. The minimum is 3.
- **Collapse key**: the key that folds the panel. Use `off` to turn it off. Run `/reload` after a change.

Settings are stored in `~/.config/pi-todo/config.json`. If `XDG_CONFIG_HOME` is set, they are stored there instead.

## When something looks wrong

1. Run `/todos refresh`.
2. Read the message. After a failure it names the earlier problem.
3. If it fails again, your tasks are unchanged. Fix the cause and retry.

A failed redraw never undoes a task change or a ticked box.

If the agent reports that a box was written but not confirmed, do this:

1. Run `/todos refresh`.
2. Open `tasks.md` and look at the box.
3. Do not ask the agent to repeat the completion.

Other cases:

- **No changes in the list.** Pi did not start in a folder with an OpenSpec root. Restart Pi in the right project.
- **A task is read-only.** Two tasks share the same wording. Make each task unique in `tasks.md`.
- **A lock error names a process.** Another writer holds the file. Wait. If that process has stopped, delete the file `tasks.md.pi-todo.lock` next to `tasks.md`.
- **You want to reopen a done task.** Remove its `x` in `tasks.md`. The next refresh shows it as open.

## Limits

- Sync mode works with `spec-driven` changes that have one `tasks.md`.
- The agent cannot rename or delete a linked task. Change the plan in OpenSpec instead.
- A ticked box records progress. It does not prove that tests passed.
- Do not edit `tasks.md` in an editor at the exact moment the agent completes a task.
- Tested on macOS with Pi 0.99.1 and OpenSpec 1.13.1.

## Tool reference for agents

The agent uses one tool named `todo`. These calls show each action. Every call also works in normal mode, except the sync fields.

Create a task:

```json
{ "action": "create", "subject": "Write tests" }
```

Start a linked task. `expectedRevision` comes from the latest `list`, `get` or result:

```json
{
	"action": "update",
	"id": 2,
	"status": "in_progress",
	"activeForm": "writing tests",
	"expectedRevision": "0123456789abcdef"
}
```

Complete a linked task:

```json
{ "action": "update", "id": 2, "status": "completed", "expectedRevision": "0123456789abcdef" }
```

Add a temporary step that is not in the plan:

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
