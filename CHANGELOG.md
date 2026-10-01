# Changelog

All notable changes are listed here. [Release Please](https://github.com/googleapis/release-please) writes this file from Conventional Commit messages when a release pull request is opened.

## [0.2.0](https://github.com/cmdaltctr/om-pi-todo/compare/v0.1.0...v0.2.0) (2026-10-01)


### Features

* nudge the agent once to update task statuses before a run settles ([24c6031](https://github.com/cmdaltctr/om-pi-todo/commit/24c60319cc5807a639c0af313d7e49f651adbc3c))
* show every panel row with Pi's expand key and name the key in the summary row ([9fac056](https://github.com/cmdaltctr/om-pi-todo/commit/9fac056a453d80e902cd7a3cf01272ee61ed076d))


### Bug Fixes

* give the status hint only when a task is completed or deleted ([c31bc07](https://github.com/cmdaltctr/om-pi-todo/commit/c31bc079fe6c65a1df05b7e795978bdc1303b419))
* read npm pack output that has script noise in front, and warn on a Node mismatch ([5a0bdf5](https://github.com/cmdaltctr/om-pi-todo/commit/5a0bdf540a13c2fbfbfdfb0dc13a172461b7ba46))
* report an archived change reliably by also watching the parent folder ([737dcac](https://github.com/cmdaltctr/om-pi-todo/commit/737dcac7b3aca4394aebc713694bb97be6534dde))
* wrap long panel rows under their connector instead of cutting them off ([72f9d96](https://github.com/cmdaltctr/om-pi-todo/commit/72f9d96d8d6ef548e08d0065529aff5be7f55d5f))

## [0.1.0](https://github.com/cmdaltctr/om-pi-todo/releases/tag/v0.1.0) (2026-10-01)

First release. It was published by hand, so later releases can use Release Please and npm trusted publishing.

### Features

- Normal mode with the same `todo` tool and `/todos` command as `@juicesharp/rpiv-todo` 2.11.0, and replay of its saved sessions.
- OpenSpec sync mode. Linked tasks come from `tasks.md`. Completing one writes the checkbox, then asks the OpenSpec CLI to confirm the same task. Success needs both.
- `/todo-settings` for the session mode, the default mode, the panel line budget and the collapse key.
- `/todos refresh` to redraw the panel without changing any task.
- A panel that counts every task, shows `Idle`, `Paused` and `Blocked by #N` honestly, and marks a stale or unavailable OpenSpec view.
- Waiting and failure reasons on tasks, and one reminder when the agent stops with work still open.

### Safety

- Task files are changed one checkbox at a time, under a per-file lock that is never taken over by age.
- Files and folders that link outside the confirmed OpenSpec root are refused.
- The OpenSpec CLI runs without a shell and with a time limit.
