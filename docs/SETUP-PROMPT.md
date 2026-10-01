# Prompt: set up tooling in another Pi extension repo

Copy the text inside the block and give it to an agent that works in the target folder. It copies the tooling used here and avoids the mistakes made while building it.

```text
You are setting up project tooling in the current directory. Work only here.

Reference project (public, MIT): https://github.com/cmdaltctr/opinionated-modular-pi-todo-system-ompts
Fetch it with `gh repo clone cmdaltctr/opinionated-modular-pi-todo-system-ompts /tmp/ompts-ref`. Copy and adapt its files. Do not edit the reference.

## Goal
Add these to this project: AGENTS.md, Oxlint, Oxfmt, a Husky pre-push hook, a clean-clone local CI gate, and a GitHub Actions workflow. Keep the code behaviour unchanged.

## Rules
1. Read first. Look at package.json, tsconfig.json, vitest config, tests and any README. Say what you found before you change anything.
2. Use Bun for installs and scripts. Use British English in docs and comments.
3. Ask before you install a dependency, create a git repo, create a GitHub repo, or push. Do not push or create a remote unless I say so.
4. Write each change test first where a test makes sense. After a check passes, break the thing it guards in a scratch copy and confirm the check fails. Never commit that break.
5. Put no personal data in files or git history: no home paths such as /Users/<name>, no personal email, no tokens. If this folder is not a git repo and you create one, set a local git email of the form `<id>+<login>@users.noreply.github.com`.

## Steps

### 1. Make the setup portable
- If tsconfig.json or vitest config contains an absolute path to a Pi install (for example /Users/<name>/.pi/agent/install/...), replace it.
  - Copy scripts/setup-host.sh from the reference. It installs the Pi host packages into `.pi-host/` at a pinned version.
  - Point tsconfig `paths` and the vitest alias at `./.pi-host/node_modules/...` with relative paths. In vitest config use `import.meta.dirname`, not `__dirname`.
  - Add `.pi-host/` to .gitignore.
- Pi host packages are `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` and `typebox`. They must stay peer dependencies. Never move them to `dependencies`.
- Add bunfig.toml with `[install]` and `peer = false`. Without it, `bun install` copies the host packages into node_modules and a CI run fails.

### 2. Lint and format
- `bun add -d oxlint oxfmt husky --omit=peer`.
- Copy .oxlintrc.json and .oxfmtrc.json from the reference. Adjust only what this code base needs. Run `bun run lint`. Fix real findings in the code. Turn off a rule in the config only with a reason, and only for a rule that is wrong for this project.
- Run `oxfmt --write` once and commit that alone as `style: format the code base`. Then run the tests.
- Scripts in package.json: `format`, `format:check`, `lint` (`oxlint --deny-warnings`), `lint:fix`, `typecheck`, `test`, `audit`, `ci`, `ci:clean`, `prepare` (`husky || true`).
- `ci` runs format:check, lint, typecheck and test, in that order.

### 3. Hooks and local CI
- Copy scripts/ci-clean.sh. It clones the committed code to a temporary folder, installs from the lockfile with `HUSKY=0`, and runs `bun run ci`. It catches faults that only a clean machine shows.
- Copy .husky/pre-push. It runs scripts/setup-host.sh and then `bun run ci:clean`.
- Run `bun run prepare`. Then check that the hook file is executable.

### 4. GitHub Actions
- Copy .github/workflows/ci.yml. It has a check job (format, lint, types, tests) and an audit job.
- Pin every action to a full commit SHA with a version comment. Look up each SHA with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`. If the tag object has type `tag`, follow it to the commit.
- Keep `permissions: contents: read`, a concurrency group, `persist-credentials: false` and a job timeout.
- If tests run a real external CLI, install the pinned version in the workflow. Make those tests skip when the CLI is missing.

### 5. AGENTS.md
- Load the `s-agents-md` skill. Write AGENTS.md from this project's real structure. Use the reference AGENTS.md as a model, not as text to copy.
- Cover: architecture and module boundaries, exact commands with their prerequisites, how tests are grouped, dos and don'ts, code style, error handling, security, git workflow, documentation.
- Check every command and path in it exists. Run the evaluator: `python3 ~/.claude/skills/s-agents-md/scripts/evaluate_agents_md.py AGENTS.md --label generated`. Report its numbers. Do not present a score.
- Load `s-plain-human` for any docs you write.

### 6. Security
- If the Aikido MCP tools are available, run `aikido_scan_paths` on every first-party source file. Fix real findings.
- Suppress a finding only after you trace the code and prove it is a false alarm. Use an inline `// nosemgrep: <rule id> -- <reason>` above the line. Record each suppression and the reason in docs/VERIFICATION.md.
- Run `bun audit`.

### 7. Docs for people who fork it
- Add a README section that lists the tooling and the commands, as the reference README does.
- Add a docs test (see test/docs.test.ts in the reference) that checks the README, scripts, hook and workflow agree with each other and with package.json.

## Check before you finish
1. `bun run ci` passes.
2. Commit everything, then `bun run ci:clean` passes.
3. Break three things on purpose in a scratch copy (a lint rule, a format rule, a docs claim). Each one must fail a check.
4. `git grep -n -I -E "/Users/|/home/[a-z]+/"` finds nothing.
5. If you were allowed to push, wait for the GitHub run and report its result. If it fails, read the log and fix the cause. Do not retry blindly.

## Report
List: files added or changed, each command you ran with its result, anything you skipped and why, open risks, and the exact next action for me.
```
