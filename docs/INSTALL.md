# How to install

This guide installs the extension into Pi. It takes about two minutes.

## Before you start

You need:

- Pi 0.99.1 or newer.
- Node.js 22 or newer.
- The `openspec` command, only if you want sync mode. Check with `openspec --version`.

## Install from npm (recommended)

1. Run this command in a terminal:

   ```sh
   pi install npm:pi-todo-openspec
   ```

2. Pi adds the package to `packages` in `~/.pi/agent/settings.json`.
3. Handle `rpiv-todo` if you use it. See the section below.
4. Open Pi, or run `/reload` in a Pi session that is already open.
5. Check that it works. Run `/todo-settings`. A menu titled "Todo settings" should open.

To install a fixed version, add it after the name:

```sh
pi install npm:pi-todo-openspec@0.1.0
```

To update later, run `pi update`.

## Install from GitHub

Use this to try the newest code before a release.

1. Run this command:

   ```sh
   pi install git:github.com/cmdaltctr/opinionated-modular-pi-todo-system-ompts
   ```

2. Pi adds the package to `packages` in `~/.pi/agent/settings.json`. For a folder path, Pi may store the path relative to that file. That is normal.
3. Handle `rpiv-todo` if you use it. See the section below.
4. Run `/reload`, then `/todo-settings` to check it works.

To install a fixed release, add a tag or commit at the end, for example `...-ompts@v0.1.0`.

## If you use rpiv-todo

`@juicesharp/rpiv-todo` also registers a tool called `todo`. Two tools with one name clash. Disable the old one and keep the package installed, so you can go back.

1. Open `~/.pi/agent/settings.json`.
2. Find this line in `packages`:

   ```json
   "npm:@juicesharp/rpiv-todo"
   ```

3. Replace it with this object. The empty `extensions` list tells Pi to load none of that package:

   ```json
   { "source": "npm:@juicesharp/rpiv-todo", "extensions": [] }
   ```

4. Run `/reload`.
5. Run `pi list`. The old package should show as `(filtered)`.

## Install from a local copy (for developers)

Use this when you want to edit the code.

1. Clone the repository and install its tools:

   ```sh
   git clone https://github.com/cmdaltctr/opinionated-modular-pi-todo-system-ompts.git
   cd opinionated-modular-pi-todo-system-ompts
   bun install
   bun run setup:host
   ```

2. Tell Pi where the folder is. Use the full path:

   ```sh
   pi install "$PWD"
   ```

3. Handle `rpiv-todo` as above, then run `/reload`.

Pi finds the package by its folder path. Edits take effect after `/reload`.

## Check the install

1. Run `pi list`. You should see the package.
2. Start Pi with no warnings about "Host-provided extension packages".
3. Run `/todos`. In a new session it says there are no todos yet.

## Problems

- **"Host-provided extension packages must be declared in peerDependencies".** Someone added `typebox` or a Pi package to `dependencies`. Move it to `peerDependencies`.
- **Two `todos` commands, or odd tool errors.** The old `rpiv-todo` is still loading. Repeat the section above and run `/reload`.
- **`/todo-settings` is missing.** Pi has not loaded the package. Run `pi list`, then `/reload`.
- **Sync mode says OpenSpec is unavailable.** Pi cannot find `openspec`. Start Pi from a shell where `openspec --version` works.
