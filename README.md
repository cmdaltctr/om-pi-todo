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
bun run ci           # format check, lint, type check and tests
```

- `bun run ci` checks your working folder. `bun run ci:clean` checks a fresh clone of your last commit, which is what CI sees.
- `git push` runs `bun run ci:clean` first, through a Husky hook. Skip it once with `git push --no-verify`.
- GitHub Actions runs the same steps on every push and pull request.
- Contributor notes for agents are in [AGENTS.md](AGENTS.md).

## Tooling you can copy

If you fork this project or start a similar Pi extension, set up the same checks. Each row says what it is for.

| Tool                                               | What it does                                                                           | Where it is configured      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------- |
| [Bun](https://bun.sh)                              | Installs packages and runs scripts.                                                    | `package.json`, `bun.lock`  |
| [Oxlint](https://oxc.rs/docs/guide/usage/linter)   | Finds bugs. Warnings fail the run.                                                     | `.oxlintrc.json`            |
| [Oxfmt](https://oxc.rs/docs/guide/usage/formatter) | Formats code and docs. It is separate from Oxlint.                                     | `.oxfmtrc.json`             |
| `tsc` (TypeScript, strict)                         | Checks types.                                                                          | `tsconfig.json`             |
| [Vitest](https://vitest.dev)                       | Runs the tests.                                                                        | `vitest.config.ts`          |
| [Husky](https://typicode.github.io/husky)          | Runs a check before each `git push`.                                                   | `.husky/pre-push`           |
| `scripts/ci-clean.sh`                              | Runs the gate on a fresh clone of your last commit, as CI does.                        | `package.json` (`ci:clean`) |
| GitHub Actions                                     | Runs format, lint, types, tests and a dependency audit on every push and pull request. | `.github/workflows/ci.yml`  |
| `bun audit`                                        | Looks for known vulnerable dependencies.                                               | `package.json` (`audit`)    |

Three details that are easy to miss:

- **Pi host packages.** Pi supplies `@earendil-works/*` and `typebox`. List them as `peerDependencies`. Add `peer = false` to `bunfig.toml`, or `bun install` will copy them into `node_modules` and a Pi packaging check will complain. `scripts/setup-host.sh` fetches them into `.pi-host/` for tests and type checks, so no path on your machine is hard-coded.
- **Pin actions.** Every action in the workflow uses a full commit SHA, not a tag.
- **Test a clean clone.** `bun run ci` can pass in your folder and fail in CI. `bun run ci:clean` removes that gap.

To set the same tooling up in another repo with an agent, use [the setup prompt](docs/SETUP-PROMPT.md).

## Licence and credit

MIT. See [LICENSE](LICENSE).

This project began as a copy of `@juicesharp/rpiv-todo` 2.11.0 (MIT, copyright juicesharp). Each reused file and its hash are listed in [NOTICE.md](NOTICE.md).
