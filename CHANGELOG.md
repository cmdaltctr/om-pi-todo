# Changelog

All notable changes are listed here. [Release Please](https://github.com/googleapis/release-please) writes this file from Conventional Commit messages when a release pull request is opened.

## [0.1.0](https://github.com/cmdaltctr/ompts-todo/releases/tag/v0.1.0) (2026-10-01)

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
