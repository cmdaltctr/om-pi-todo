# Verification record

This page records how the extension was checked, what the security scan found, and which risks remain.

- Recorded on 2026-10-01.
- Tested with Pi 0.99.1, OpenSpec CLI 1.13.1, Node 26.9, Vitest 5.0.3 and TypeScript 7.0.2.

## Checks and results

| Check | Command | Result |
| --- | --- | --- |
| Tests | `bun run test` | 30 files, 666 tests, all passing. About 25 seconds on an idle machine. |
| Lint | `bun run lint` | Oxlint, warnings denied. No findings. |
| Type check | `bun run typecheck` | `tsc` in strict mode. No errors. |
| Dependency audit | `bun run audit` | No known vulnerabilities. |
| Security scan | Aikido, over every source file | See below. |
| Real CLI | Tests that run the installed `openspec` in temporary folders | Passing. They skip when `openspec` is missing. |

Run `bun run ci` to repeat the first three checks. GitHub Actions runs them on every push.

## Security findings

The scan found one real issue. It also reports 16 findings of one type that I judge to be false alarms.

| Finding | Count | Verdict | Action |
| --- | ---: | --- | --- |
| Token compared with `!==` in the lock release (`AIK_ts_node_timing_attack`) | 1 | Real pattern. Low risk, because the token is not a secret. | Fixed. The code now uses `crypto.timingSafeEqual`. |
| File access with a path variable (`AIK_ts_generic_path_traversal`) | 16 | False alarms. Every path is contained. | Not suppressed in Aikido. The owner decides. |

Why the path findings are false alarms:

- **Writes to a task file.** The file and its folder are resolved with `realpath`. Both must be inside the confirmed OpenSpec root. A link that leaves the root is refused. Tests cover a file link and a folder link.
- **Lock and temporary files.** They sit beside the real task file. They are created with the `wx` flag, so the open fails if the name already exists.
- **Reads of the task file.** The path comes from `openspec status`. Before the first read, the code resolves the file, its folder and the root with `realpath`. It refuses a link that leads outside. The writer checks again just before it replaces the file.
- **Settings file.** The path comes from `XDG_CONFIG_HOME` (absolute paths only) or the home folder. The user controls both. No tool input reaches it.
- **CLI arguments.** A change name must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. The CLI runs without a shell. A test sends hostile text such as `; touch PWNED` and checks that nothing runs.

## Safeguard removal tests

Each safeguard was removed in a scratch copy of the code. The suite was then run. A removal counts as caught when at least one test fails.

| Safeguard removed | Tests that failed |
| --- | ---: |
| Confirming CLI read after the write | 7 |
| Check that the same task is confirmed | 7 |
| Waiting for the write to finish | 3 |
| Redraw after a completed write | 1 |
| Redraw after any tool update | 15 |
| Redraw after a refresh | 9 |
| Binding check on refresh | 3 |
| Binding check before the file is replaced | 1 |
| Binding check before the view is published | 2 |
| One queue per file (not one queue for all files) | 2 |
| Newest refresh wins over an older one | 2 |
| Write block after an unconfirmed completion | 4 |
| Lock release after a failed write | 1 |
| Watcher closed on stop | 1 |
| Watcher does not overlap runs | 1 |
| No synchronous file read in the runtime | 1 |
| Running mark tied to the agent run | 1 |
| Abort signal passed to the CLI | 1 |

A first pass ran only three test files and missed 11 of these. A second pass ran the whole suite and caught 10. The last one was a real gap. A test now checks that the caller's abort signal reaches every CLI call.

Earlier work used the same method. Each behaviour test was run against a deliberately broken copy, and weak tests were made stronger until the breakage failed them.

## Asynchronous behaviour

- `test/acceptance-async.test.ts` holds each file or CLI step open on purpose.
- While a step is held, it checks that timers keep running, input is handled, the panel draws and other sessions work.
- It also checks that no completion is reported or shown before both the checkbox write and the CLI confirmation finish.
- `test/acceptance-static.test.ts` scans the source. It forbids synchronous file or process calls, file access while rendering, busy waits and timers that are never cleared.

## Known risks

1. **Editors that ignore the lock.** A tool that does not use the lock can still change the file in the last moment before the replace. A revision check narrows this gap but cannot close it on a plain file system.
2. **Stale lock files.** A crashed Pi can leave `tasks.md.pi-todo.lock`. The extension never removes it by itself, because it cannot prove the owner has stopped. A person must delete it.
3. **Link swapped between check and read.** The link check and the read are two calls. A link swapped in between could be read once. The CLI reads the same file in the same window, so this adds no new exposure. It needs write access to the change folder.
4. **A ticked box is not proof.** A ticked box records progress. It does not show that tests passed.
5. **Tasks with the same wording are read-only.** The extension cannot match them to one checkbox.
6. **Slow machines.** The tests that use real file watchers depend on operating system timing. They failed once under heavy load. Their deadlines are now long.
7. **OpenSpec format changes.** The task parser matches OpenSpec 1.13.1. A newer release may need an update. The writer refuses to act when the file and the CLI disagree.
8. **One platform.** All runs were on macOS.
