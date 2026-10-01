# Opinionated modular Pi todo system (OMPTS)

A todo list for the [Pi](https://github.com/earendil-works/pi) coding agent. It has two modes.

- **Normal mode** keeps a task list for one session.
- **OpenSpec sync mode** shows the tasks of one [OpenSpec](https://github.com/Fission-AI/OpenSpec) change. When the agent completes a task, the extension ticks the box in `tasks.md` and checks that OpenSpec agrees.

## Why use it

- The panel counts every task, so hiding finished rows does not hide your progress.
- Stopped work shows `Idle` or `Paused`. It never looks like it is still running.
- A task is complete only when the box is written and OpenSpec confirms it.
- A stale or broken view is marked as stale. It never passes for current.
- `/todos refresh` redraws the panel without changing any task.

## Install

```sh
pi install git:github.com/cmdaltctr/opinionated-modular-pi-todo-system-ompts
```

Then run `/reload` in Pi. If you already use `@juicesharp/rpiv-todo`, read the install guide first. Both register a `todo` tool, so you must disable one.

## Tell your agent how to use it

The `todo` tool already carries these rules in its own guidance. Add this block to `~/.pi/agent/AGENTS.md` (or a project `AGENTS.md`) if your agent still skips them.

```markdown
## Todo list (OMPTS extension)

- Use the `todo` tool for work with 3 or more steps. Set a task `in_progress` before you start. Set it `completed` the moment it is done.
- In OpenSpec sync mode, call `list` first. Work under the listed task ids. Do not copy plan tasks into new tasks.
- Pass `expectedRevision` when you change a linked task's status. Take it from the latest `list`, `get` or result.
- Complete a linked task only when its acceptance criteria are met. A ticked box is not proof that tests passed. Say what you ran and what it showed.
- For a temporary step outside the plan, use `scope: "incidental"` with a `reason`.
- Set `waitingReason` when you wait for an approval or a review. Set `failureReason` when work fails. Clear each with an empty string when it is resolved.
- If a result says a box was written but not confirmed, stop and tell the user. Do not repeat the completion.
```

## Documentation

- [How to install](docs/INSTALL.md)
- [How to use](docs/USAGE.md)
- [How to uninstall](docs/UNINSTALL.md)
- [Verification record](docs/VERIFICATION.md): checks, security findings and known risks

## Requirements

- Pi 0.99.1 or newer. Tested on 0.99.1.
- Node.js 22 or newer.
- The `openspec` command on your PATH, for sync mode only. Tested with 1.13.1.

Pi supplies these host packages. The extension lists them as peers and ships no copy: `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` and `typebox`.

## Develop

```sh
bun install
bun run setup:host   # fetches the Pi host packages into .pi-host/
bun run ci           # lint, type check and tests
```

- `bun run ci` checks your working folder. `bun run ci:clean` checks a fresh clone of your last commit, which is what CI sees.
- `git push` runs `bun run ci:clean` first, through a Husky hook. Skip it once with `git push --no-verify`.
- GitHub Actions runs the same steps on every push and pull request.
- Contributor notes for agents are in [AGENTS.md](AGENTS.md).

## Licence and credit

MIT. See [LICENSE](LICENSE).

This project began as a copy of `@juicesharp/rpiv-todo` 2.11.0 (MIT, copyright juicesharp). Each reused file and its hash are listed in [NOTICE.md](NOTICE.md).
