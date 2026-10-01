# OMPTS: Opinionated Modular Pi Todo System

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
pi install npm:pi-todo-openspec
```

Then run `/reload` in Pi. To install from GitHub instead, see the install guide. If you already use `@juicesharp/rpiv-todo`, read the install guide first. Both register a `todo` tool, so you must disable one.

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

## Release (maintainers)

Releases go to npm as `pi-todo-openspec`. [Release Please](https://github.com/googleapis/release-please) prepares each one. You never edit the version or the changelog by hand.

1. Write commits and pull request titles in the [Conventional Commits](https://www.conventionalcommits.org) style: `feat:`, `fix:`, `perf:`, `docs:`. Add `!` for a breaking change, for example `feat!:`.
2. Merge to `main`. Release Please opens or updates a pull request called "chore(main): release X.Y.Z". It bumps `version` in `package.json` and writes `CHANGELOG.md`.
3. Read that pull request. Check the version and the changelog text.
4. Merge it. Release Please tags the commit and creates a GitHub release.
5. The publish job runs the full gate on that exact commit, then **stages** the version on npm. It is not installable yet. The job adds the approval steps to the GitHub release.
6. Approve it with two-factor authentication:

   ```sh
   npm stage list pi-todo-openspec
   npm stage approve <stage-id>
   ```

   You can also use the Staged tab at https://www.npmjs.com/package/pi-todo-openspec. To reject a version, run `npm stage reject <stage-id>`.

What each commit type does before version 1.0.0:

| Commit                                      | Version change                    |
| ------------------------------------------- | --------------------------------- |
| `fix:`, `perf:`                             | Patch, for example 0.1.0 to 0.1.1 |
| `feat:`                                     | Minor, for example 0.1.0 to 0.2.0 |
| `feat!:` or a `BREAKING CHANGE:` footer     | Minor. After 1.0.0 it is major.   |
| `docs:`, `style:`, `test:`, `chore:`, `ci:` | No release                        |

### One-time setup

No secrets are needed. There is no npm token and no GitHub App key. npm trusts the release workflow through OIDC. A trusted publisher can only be added to a package that already exists, so publish the first version by hand.

1. Publish the first version by hand, then tag it and create its GitHub release, so Release Please counts from it:

   ```sh
   npm login
   npm publish --provenance=false --access public --ignore-scripts
   git tag v0.1.0 && git push origin v0.1.0
   gh release create v0.1.0 --title v0.1.0 --notes-file CHANGELOG.md
   ```

2. Allow Release Please to open pull requests. In GitHub, open Settings, Actions, General, and turn on "Allow GitHub Actions to create and approve pull requests". Or run:

   ```sh
   gh api -X PUT repos/cmdaltctr/ompts-todo/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
   ```

3. Create the environment `npm-publish`, limited to the `main` branch. In GitHub, open Settings, Environments.
4. Add the npm trusted publisher. It needs npm 11.15 or later and asks for 2FA. The names must match exactly:

   ```sh
   npm trust github pi-todo-openspec --file release.yml --repo cmdaltctr/ompts-todo --env npm-publish --allow-stage-publish
   npm trust list pi-todo-openspec
   ```

   `--allow-stage-publish` lets the workflow stage a version but not release it. You still approve every release.

5. Turn the workflow on:

   ```sh
   gh variable set RELEASE_PLEASE_ENABLED --body true
   ```

If the publish job fails with `ENEEDAUTH`, the workflow file name, the environment name or the repository in step 4 does not match npm's record. Nothing is published. Fix the setting and run the job again.

After the first staged release is approved and shows a provenance badge, open the package settings on npmjs.com and choose "Require two-factor authentication and disallow tokens".

If the gate fails, nothing is staged. The tag and GitHub release already exist. Push a `fix:` commit. Release Please then proposes the next patch version.

The release pull request is opened with the built-in token, so GitHub does not run the normal CI checks on it. The publish job runs the full gate again before it stages anything, so a broken release cannot reach npm. To get CI on the release pull request as well, use a GitHub App token in the release job.

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

## Licence and credit

MIT. See [LICENSE](LICENSE).

This project began as a copy of `@juicesharp/rpiv-todo` 2.11.0 (MIT, copyright juicesharp). Each reused file and its hash are listed in [NOTICE.md](NOTICE.md).
