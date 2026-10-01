# Verification record

Change: `add-openspec-todo-sync`. Recorded on 2026-10-01 at the end of Stage 7.
Environment: Pi 0.99.1, OpenSpec CLI 1.13.1, Node 26.9, Vitest 5.0.3, TypeScript 7.0.2.

## Commands

| Purpose | Command | Result |
| --- | --- | --- |
| Regression suite | `./node_modules/.bin/vitest run` | 29 files, 635 tests, all passing (about 23 s on an idle machine) |
| Type check | `./node_modules/.bin/tsc -p .` (`strict`) | 0 errors |
| Dependency audit | `bun audit` | No vulnerabilities in 223 packages |
| Security scan | Aikido `aikido_scan_paths` over all 37 `src` files plus `package.json`, `tsconfig.json`, `vitest.config.ts` | See findings below |
| Real CLI | Tests marked `describe.skipIf(!HAS_CLI)` run the installed `openspec` in disposable roots | Passing |

## Security findings

The first scan reported 14 findings: 13 path-pattern findings and 1 timing-comparison finding. After the timing fix the second scan reported 16, all path-pattern. The count rose from 13 to 16 although the writer was not edited between the scans. The first scan covered 37 files and the second 40 (it added `package.json`, `tsconfig.json` and `vitest.config.ts`). The cause of the difference is not established. All 16 sit on file-system calls that take a path variable.

| Finding | Count | Assessment | Action |
| --- | --- | --- | --- |
| `AIK_ts_generic_path_traversal` | 16 | See the path-control analysis below. Every path is contained or derived from a contained path. | Not suppressed in the Aikido platform. Left for the owner to accept or ignore. |
| `AIK_ts_node_timing_attack` on the lock token comparison | 1 | Genuine pattern, low real risk: the token is not a secret. | Fixed. `lock.ts` now compares with `crypto.timingSafeEqual`. Not reported on the rescan. |

### Path-control analysis

- **Writes to a task file** (`writer.ts`): the file and the change directory are resolved with `realpath`, and both must lie inside the confirmed planning root. A link that leaves the root is refused (`unsafe-path`). Tests cover a file link and a directory link that escape.
- **Lock and staging files**: derived from the real path of the target, in the same directory. They are created with `wx`, which cannot follow a link.
- **Reads of the task file** (`snapshot.ts`): the path comes from `openspec status`, and `checkStatus` requires it to be inside the change directory, which must be inside the planning root. A link inside that directory that points outside is not rejected on read. See residual risks.
- **Preferences** (`preferences.ts`): the path is built from `XDG_CONFIG_HOME` (absolute only) or the home directory. The user controls both. No tool or model input reaches it.
- **Change names** that become CLI arguments must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. The CLI runs without a shell. A test passes hostile arguments such as `; touch PWNED` and confirms nothing runs.

## Test-failure demonstrations

Each safeguard was removed in a scratch copy and the suite was run. A removal counts as caught when at least one test fails.

Stage 7 safeguard removals (all caught):

| Safeguard removed | Tests failing |
| --- | --- |
| Confirming CLI refresh after the write (early success) | 7 |
| Confirmation of the target task | 7 |
| Awaiting persistence | 3 |
| Render scheduling after a completed write | 1 |
| Render scheduling after any tool update | 15 |
| Render scheduling after reconciliation | 9 |
| Binding-generation check on refresh | 3 |
| Binding-generation check before the file replace | 1 |
| Binding-generation check before the runtime publishes | 2 |
| Per-target queue (serialising across unrelated targets) | 2 |
| Newest-result-wins ordering of overlapping refreshes | 2 |
| Write block after an unconfirmed completion | 4 |
| Lock release on a failed section | 1 |
| Watcher close on stop | 1 |
| Coalescer overlap guard | 1 |
| Synchronous file read in the runtime | 1 |
| Running indicator tied to the agent run | 1 |
| Abort signal passed to the CLI | 1 (after a test was added) |

The first pass, which ran only the three acceptance files, missed 11 of these. The tests that cover them live in earlier stage files. The second pass ran the whole suite and caught 10 of the 11. The eleventh, abort propagation, was a real gap. A test now asserts that the caller's signal reaches every CLI call a tool invocation makes.

Earlier stages used the same method. Every behaviour test was checked against a deliberately broken scratch copy, and weak tests were strengthened until the breakage failed them.

## Asynchronous test results

`test/acceptance-async.test.ts` (23 tests) holds each I/O stage open with a deferred promise. While a stage is held it checks that timer ticks continue, an unrelated session works, input events dispatch, and the panel renders. It also checks that no success or confirmed state appears before both persistence and CLI confirmation finish.

`test/acceptance-static.test.ts` checks the source for synchronous file, process and wait calls, for I/O in render modules, for busy waiting, and for timers without cleanup.

## Residual risks

1. **Editors that ignore locks.** A final read-to-rename race remains with a writer that does not use the lock. A revision check before the replace narrows it but cannot close it on a plain file system.
2. **Stale lock files need manual removal.** The design forbids taking over a lock by age or apparent death. A crashed Pi leaves a lock that a person must delete.
3. **Symlinked task file read.** A task file that is a link to a place outside the planning root can be read, because the CLI reads it. It is never written. Tasks.md content could then appear in `list`. This needs an author with write access to the change directory.
4. **Checked box is not proof.** A checked box records progress. The tool output says so, but the extension cannot tell whether tests passed.
5. **Duplicate-wording tasks are read-only.** By design, identical task wording cannot be mapped to one checkbox.
6. **Timing-sensitive tests.** Real file-watcher tests depend on operating system event latency. They have long deadlines. They failed once under heavy machine load before the deadlines were raised.
7. **OpenSpec format drift.** Parser parity is tested against 1.13.1. A different release may need the scanner updated. The writer refuses when the file and the CLI disagree.
8. **Not tested on other platforms.** All runs were on macOS.
9. **Activation not done.** The extension is not loaded by Pi. Stage 8 covers activation and rollback.
