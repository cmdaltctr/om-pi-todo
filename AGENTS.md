# AGENTS.md

A todo extension for the Pi coding agent. It has a normal mode and an OpenSpec sync mode. In sync mode the task file `tasks.md` is the source of truth. Read this file before you change code.

## Architecture

The entry point is `src/extension.ts`. Pi calls its default export once with the `ExtensionAPI` object.

| Path                                                           | Responsibility                                                                                                                     |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/extension.ts`                                             | Wires Pi events, the runtime, the panel and the commands.                                                                          |
| `src/todo.ts`                                                  | Registers the `todo` tool and the `/todos` command.                                                                                |
| `src/state/`                                                   | Pure task rules (reducer), the per-session store, replay, run state.                                                               |
| `src/openspec/`                                                | Everything that touches OpenSpec: CLI runner, discovery, task scanner, reconcile, snapshot provider, patch, lock, writer, watcher. |
| `src/sync/`                                                    | Sync-mode runtime, the sync `todo` path, shared view text, saved session data.                                                     |
| `src/view/`, `src/todo-overlay.ts`                             | Panel rendering and row presentation.                                                                                              |
| `src/preferences.ts`, `src/session-mode.ts`, `src/settings.ts` | Global settings, per-session mode, `/todo-settings`.                                                                               |

Keep these boundaries.

- The panel, the shared text and the reducer do no file, process or network access. A test enforces this.
- All file and process access is asynchronous. A test forbids `*Sync` calls and busy waits.
- The tool, `/todos` and the panel read one snapshot. Add new views on top of `src/sync/text.ts`.
- Only `src/openspec/writer.ts` writes a task file. It changes one checkbox marker and nothing else.
- Local task ids are never reused. CLI row numbers are positions, never identities.
- Files stay under about 500 lines. Split by responsibility.

Pi is the host. `@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui` and `typebox` are wildcard peers. Never move them to `dependencies`. Never import any `rpiv-*` package.

## Commands

Run all commands in the repository root. Set up a fresh clone with these two commands:

```sh
bun install
bun run setup:host
```

| Purpose                                 | Command                                              | Needs                 |
| --------------------------------------- | ---------------------------------------------------- | --------------------- |
| Install tools                           | `bun install`                                        | Network               |
| Fetch Pi host packages into `.pi-host/` | `bun run setup:host`                                 | Network, `npm`        |
| Format check                            | `bun run format:check`                               |                       |
| Format files                            | `bun run format`                                     |                       |
| Lint                                    | `bun run lint`                                       |                       |
| Type check                              | `bun run typecheck`                                  | `.pi-host/`           |
| All tests                               | `bun run test`                                       | `.pi-host/`           |
| One test file                           | `./node_modules/.bin/vitest run test/<name>.test.ts` | `.pi-host/`           |
| Full gate on your working folder        | `bun run ci`                                         | `.pi-host/`           |
| Full gate on a fresh clone of HEAD      | `bun run ci:clean`                                   | `.pi-host/`, a commit |
| Dependency audit                        | `bun run audit`                                      | Network               |

- Real-CLI tests need `openspec` 1.13.1 on the PATH. They skip when it is missing.
- Startup tests need `pi` on the PATH. They skip when it is missing.
- Run `bun run ci` before you finish any change. It must pass.
- Commit, then run `bun run ci:clean`. A passing `ci` can still fail in CI, because your folder differs from a clean clone.

## Testing

Test files group by area.

| Area                      | Files                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| Normal mode and replay    | `normal-mode`, `legacy-replay`, `session-mode`, `preferences`, `settings`                     |
| OpenSpec reading          | `openspec-exec`, `discover`, `task-parity`, `reconcile`, `snapshot`                           |
| OpenSpec writing          | `patch`, `lock`, `writer`                                                                     |
| Tool, panel and lifecycle | `sync-tool`, `sync-runtime`, `sync-extension`, `overlay`, `presentation`, `panel-reliability` |
| Acceptance                | `acceptance-async`, `acceptance-cli`, `acceptance-screenshot`, `acceptance-static`            |
| Packaging and docs        | `packaging`, `startup`, `docs`                                                                |

- Write the test before the fix. Confirm it fails on the broken code.
- After a test passes, break the code under test in a scratch copy. Confirm the test fails. Never commit that break.
- Hold an I/O stage open with `test/gate.ts`. Never use a fixed sleep as proof.
- Use disposable temp directories. Never write to a real OpenSpec root or to `~/.config`.
- Tests fake the CLI through `test/fake-cli.ts` and `test/panel-harness.ts`. Use them before you write new harnesses.
- Parser parity tests compare against the real CLI. Update `src/openspec/tasks.ts` when OpenSpec changes its parser.
- Real file-watcher tests are slow under heavy machine load. Raise a deadline only after you prove load is the cause.

## Dos and don'ts

- Do report an outcome as it is: written, confirmed, unconfirmed or cancelled.
- Do keep a failed redraw separate from a failed write.
- Do not report a completion as done until the checkbox is written and the CLI confirms the same task.
- Do not roll back or repeat a write that has landed.
- Do not take over a lock file by age or because its owner looks dead.
- Do not add a setting, flag or abstraction that no requirement asks for.
- Do not edit `src/` files copied from upstream without a reason. `NOTICE.md` lists them.

## Code style

- Use TypeScript in strict mode, ES modules, and tab indentation.
- Import local files with the `.js` suffix, for example `./preferences.js`.
- Write comments in British English. Say why, not what.
- Name test files `<topic>.test.ts`. Put shared helpers in `test/*.ts` without the `.test` suffix.
- Run `bun run format`, then `bun run lint:fix`, then `bun run lint`. Oxfmt formats code. Oxlint finds bugs and runs with warnings denied.
- Do not disable a lint rule inline without a reason in the same comment.

## Error handling

- Return failures as values. Do not throw across a module boundary that callers cannot handle.
- Every launched promise must be observed. Report its failure through `onError` or a result.
- Tool errors tell the agent what to do next.
- A stale or failed read keeps the last good view and marks it `stale`. It disables linked writes.

## Security

- Run the OpenSpec CLI with an argument array and no shell.
- Check that every written path stays inside the confirmed planning root after `realpath`.
- Remove terminal control characters from any text shown in the panel or a notification.
- Never put secrets, tokens or personal paths in code, tests or docs.
- Scan changed first-party files with the Aikido tool when it is available, and fix findings.
- `docs/VERIFICATION.md` lists open findings and known risks.

## Git and pull requests

- Use Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`.
- Write commit messages in British English and in the imperative.
- Run `git pull --rebase` before you push.
- A Husky hook runs `bun run ci:clean` on `git push`. Do not use `--no-verify` unless the user asks.
- GitHub Actions runs lint, types, tests and an audit on every push and pull request. All must pass.
- Ask before you install a dependency, push, force-push, tag, publish, or delete files.
- Use Conventional Commit messages. Release Please reads them to pick the next version. A commit that is not in that style is ignored.
- Never edit `version` in `package.json`, `CHANGELOG.md` or `.release-please-manifest.json` by hand. Release Please changes them in its release pull request.
- Publish only through `.github/workflows/release.yml`. It stages the version on npm. Never run `npm publish`, `npm stage approve` or `npm stage reject`, and never push a tag by hand. The maintainer approves each staged version with 2FA.
- There is no npm token. Do not create or ask for one. A failing publish with `ENEEDAUTH` means the trusted publisher setting on npm does not match.
- Use squash merge for pull requests, and make the pull request title a Conventional Commit.
- `npm pack --dry-run` must list only `src/`, the guides, `CHANGELOG.md`, `NOTICE.md`, `LICENSE`, `README.md` and `package.json`. A test checks it.

## Documentation

- Update `docs/INSTALL.md`, `docs/USAGE.md` or `docs/UNINSTALL.md` when behaviour changes.
- `test/docs.test.ts` checks the examples in those files against the real tool and commands. Keep it passing.
- Write in plain British English with short sentences and numbered steps.
