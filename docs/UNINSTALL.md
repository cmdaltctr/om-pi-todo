# How to uninstall

This guide removes the extension and puts Pi back as it was. Nothing is deleted from your work.

## Remove the extension

1. Run the command that matches how you installed it.

   From npm:

   ```sh
   pi remove npm:pi-todo-openspec
   ```

   From GitHub:

   ```sh
   pi remove git:github.com/cmdaltctr/ompts-todo
   ```

   From a local copy. Use the same full path you installed:

   ```sh
   pi remove /full/path/to/ompts-todo
   ```

2. Run `pi list`. The package should be gone.

## Bring back rpiv-todo

Do this only if you disabled `@juicesharp/rpiv-todo` when you installed.

1. Open `~/.pi/agent/settings.json`.
2. Find this entry in `packages`:

   ```json
   { "source": "npm:@juicesharp/rpiv-todo", "extensions": [] }
   ```

3. Replace it with the plain form:

   ```json
   "npm:@juicesharp/rpiv-todo"
   ```

4. Run `/reload` in Pi.
5. Run `pi list`. The `(filtered)` mark should be gone.

If you removed `rpiv-todo` completely, install it again with `pi install npm:@juicesharp/rpiv-todo`.

## Check that it worked

1. Run `pi list`. The package should not appear.
2. Start a new Pi session. `/todo-settings` should no longer be offered.
3. Run `/todos`. It comes from `rpiv-todo` if you restored it.
4. Check that Pi starts with no warnings.

## What stays after uninstall

| Item                            | What happens                                                       |
| ------------------------------- | ------------------------------------------------------------------ |
| Your session history            | Stays. Plain task lists still load in `rpiv-todo`.                 |
| Ticked boxes in `tasks.md`      | Stay. The extension never undoes them.                             |
| OpenSpec mode                   | Gone. Without this extension, a session shows its basic list only. |
| `~/.config/pi-todo/config.json` | Stays. It does no harm.                                            |

## Clean up (optional)

1. Delete the settings file if you want no trace:

   ```sh
   rm ~/.config/pi-todo/config.json
   ```

   If you set `XDG_CONFIG_HOME`, the file is in that folder instead.

2. Look for leftover lock files in your OpenSpec changes. They exist only if Pi crashed during a write:

   ```sh
   find . -name '*.pi-todo.lock'
   ```

3. Delete any you find, but only when no Pi session is writing.
4. Delete the cloned folder if you installed from a local copy.
