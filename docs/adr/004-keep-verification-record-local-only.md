# ADR-004: Keep the verification record and graph output local only

- **Date:** 2026-10-01
- **Status:** Accepted
- **Deciders:** Dr Muhammad Aizat Bin Md Hawari

## Context

`docs/VERIFICATION.md` listed open security findings and known risks.
It was shipped in the npm package and linked from the readme, the agent guide, the test suite and six source comments.
A public record of open findings helps nobody who installs the package.
The maintainer also keeps working notes in `docs/local-docs/` and a graph in `graphify-out/`. Neither belongs in the repository.

`bun run ci` then failed at the format check. `oxfmt --check` read `graphify-out/graph.json`, which is untracked and globally ignored by git.
A clean clone has no such file, so the failure only showed on the maintainer's machine.

## Decision

1. Remove `docs/VERIFICATION.md` from the repository. The maintainer keeps a copy in `docs/local-docs/`.
2. Add `docs/local-docs/` to `.gitignore`.
3. Remove every reference to the file: the readme link, the line in `AGENTS.md`, the `files` entry in `package.json`, two lists in `test/docs.test.ts`, and the `(see docs/VERIFICATION.md)` text in `nosemgrep` comments. Each comment keeps its reason.
4. Add `graphify-out/**` and `docs/local-docs/**` to `ignorePatterns` in `.oxfmtrc.json`, so the format check reads only tracked files.

## Consequences

### Positive

- The package holds only what a user needs.
- `bun run ci` gives the same result on the maintainer's machine and in a clean clone.

### Negative

- Open findings are no longer visible to contributors. They live in the maintainer's local notes.
- Anyone who wants the old record must read git history (`git show 8c0b091:docs/VERIFICATION.md`).

### Neutral

- `npm pack --dry-run` lists one file fewer. The packaging test passes unchanged.

## Alternatives Considered

| Option                                                   | Rejected Because                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| **Keep the file in the repository**                      | It publishes open findings with every release.                     |
| **Keep it, but out of the npm package**                  | The readme and guide would still point at a file users cannot see. |
| **Format the whole tree, delete graph output before CI** | It depends on the maintainer remembering a step.                   |
| **Limit `format:check` to `src` and `test`**             | Docs and config files would lose format checks.                    |

## References

- `.gitignore`, `.oxfmtrc.json`, `package.json`
- Commits `2f82d76`, `86764cf` and `ec7620a`
- `AGENTS.md`, section "Security"
