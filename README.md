# scoped-yolo

A minimal permissions plugin for [Amp](https://ampcode.com) that makes deletes safer
without getting in your way:

1. **`rm` becomes `trash`.** Every `rm` / `rmdir` the agent runs is rewritten to
   [`trash`](https://hasseg.org/trash/), so deletions are reversible — fish files back
   out of the system trash if needed.
2. **Ask before deleting outside the workspace.** When a delete targets a path outside
   the workspace, you get one prompt per *folder* per thread. Approve once and any
   subsequent deletes inside that folder (or its subfolders) proceed silently.

In-workspace deletes are never prompted — they are just transparently rewritten to
`trash`.

## Requirements

- [Amp](https://ampcode.com) (the plugin runs under Amp's bundled Bun runtime).
- [`trash`](https://hasseg.org/trash/) on your `PATH`. On macOS:

  ```sh
  brew install trash
  ```

## Install

Amp loads plugins as `*.ts` files directly inside `~/.config/amp/plugins/` (user-wide)
or `.amp/plugins/` (per project). The plugin name is taken from the file name and shows
up in the command palette (e.g. `scoped-yolo: …`), so install it as `scoped-yolo.ts`.

Symlink the entry point (recommended — picks up local edits automatically):

```sh
mkdir -p ~/.config/amp/plugins
ln -sf "$PWD/src/index.ts" ~/.config/amp/plugins/scoped-yolo.ts
```

Or copy if you prefer (must re-copy after each change):

```sh
cp src/index.ts ~/.config/amp/plugins/scoped-yolo.ts
```

Then open Amp's command palette and run `plugins: reload` (or restart Amp). You should
see this in Amp's logs:

```text
scoped-yolo loaded — rm→trash + ask-before-outside-delete
```

## Behaviour

| Command the agent runs                   | What happens                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `rm -rf node_modules` (inside workspace) | Rewritten to `trash node_modules`, no prompt                                |
| `rm -rf /tmp/foo`                        | Prompt: *Allow deletes anywhere inside `/tmp` for the rest of this thread?* |
| `rm -rf /tmp/bar` (after approval above) | Rewritten to `trash /tmp/bar`, no prompt                                    |
| `rm -rf /var/log/x` (different folder)   | New prompt for `/var/log`                                                   |
| `mkdir tmp && rm -rf old && echo done`   | Rewritten to `mkdir tmp && trash old && echo done`                          |

If the user denies a folder, the tool call is rejected with a clear message and the
agent can pick another approach.

If no interactive UI is available (e.g. running headless) and a delete targets an
outside-workspace path, the call is rejected fail-closed.

## Commands

Available in Amp's command palette under the `scoped-yolo:` category:

- **Show approved delete folders** — list folders this thread has approved.
- **Clear approved delete folders** — forget approvals for this thread.

## Development

```sh
mise install        # installs Bun
bun install
bun test            # 32 tests: rm parser/rewriter + end-to-end plugin behaviour
bun run typecheck
```

## What's not handled

- Other deletion paths (`find -delete`, `unlink`, custom delete scripts) are not
  detected. The plugin only intercepts `rm` and `rmdir`. Add cases to `parseDeletes` /
  `rewriteRmToTrash` in [`src/index.ts`](src/index.ts) if you want more.
- File-tool deletes (e.g. `apply_patch` removing a file) are not prompted — they don't
  go through `rm`.
