# scoped-yolo

A minimal permissions plugin for [Amp](https://ampcode.com) that makes deletes safer
without getting in your way:

1. **Deletions become `trash`.** Every `rm` / `rmdir` / `unlink` (and `find -delete`,
   `find -exec rm`, `xargs rm`, …) the agent runs is rewritten to call `trash`, so
   deletions are reversible — fish files back out of the system trash if needed.
2. **Ask before deleting outside the workspace.** When a delete targets a path outside
   the workspace, you get one prompt per *folder* per thread. Approve once and any
   subsequent deletes inside that folder (or its subfolders) proceed silently. The
   same prompt fires for `apply_patch` calls that would delete files outside the
   workspace.

## Mental model

- **Strictly inside the workspace?** Silently rewrite the delete to `trash` (reversible).
- **Outside the workspace?** Prompt once per folder per thread; on approval, rewrite to
  `trash` and remember the folder.
- **The workspace root itself** (e.g. `rm -rf .` from the workspace root) is treated as
  outside, so it still prompts.
- **Approval scope is by folder, not by individual target.** Deleting `/tmp/foo.txt`
  asks you to approve `/tmp` (the parent dir); deleting the directory `/tmp/build/`
  asks you to approve `/tmp/build` itself.

## Requirements

- [Amp Neo](https://ampcode.com/news/neo) — plugins require the Neo runtime
  (the plugin itself runs under Amp's bundled Bun runtime).
- A `trash` command on your `PATH`. Pick one:

  - **macOS 14 Sonoma and later** ships a built-in [`/usr/bin/trash`](https://apple.stackexchange.com/a/476506/17907) — nothing to install.
  - **Older macOS:** `brew install trash` (Ali Rantakari's [`trash`](https://hasseg.org/trash/)).
  - **Linux:** `trash-cli` (`apt install trash-cli`, `brew install trash-cli`, etc.).

## Install

Amp loads plugins as `*.ts` files directly inside `~/.config/amp/plugins/` (user-wide)
or `.amp/plugins/` (per project). The plugin name is taken from the file name and shows
up in the command palette (e.g. `scoped-yolo: …`), so install it as `scoped-yolo.ts`.

Symlink the entry point (recommended — picks up local edits automatically):

```sh
mise run install
```

That runs:

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

### Shell deletions

| Command the agent runs                            | What happens                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| `rm -rf node_modules` (inside workspace)          | Rewritten to `trash node_modules`, no prompt                                |
| `rmdir build`                                     | Rewritten to `trash build`                                                  |
| `unlink foo.txt`                                  | Rewritten to `trash foo.txt`                                                |
| `find /tmp/old -name "*.log" -delete`             | Rewritten to `find /tmp/old -name "*.log" -exec trash {} +`                 |
| `find . -type f -exec rm -f {} +`                 | Rewritten to `find . -type f -exec trash {} +`                              |
| `find . -name "*.tmp" -print0 \| xargs -0 rm -f`  | Rewritten to `find . -name "*.tmp" -print0 \| xargs -0 trash`               |
| `rm -rf /tmp/foo`                                 | Prompt: *Allow deletes anywhere inside `/tmp` for the rest of this thread?* |
| `rm -rf /tmp/bar` (after approval above)          | Rewritten to `trash /tmp/bar`, no prompt                                    |
| `rm -rf /var/log/x` (different folder)            | New prompt for `/var/log`                                                   |
| `mkdir tmp && rm -rf old && echo done`            | Rewritten to `mkdir tmp && trash old && echo done`                          |

### File-tool deletions

`apply_patch` calls that contain `*** Delete File: <path>` markers are intercepted too:

- Inside-workspace deletes are allowed and logged so the deletion is visible.
- Outside-workspace deletes go through the same per-folder prompt as shell deletes.
- The patch itself isn't rewritten, so these deletions aren't reversible via `trash` —
  the prompt is your only line of defence.

### Denial / headless

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
mise run test       # 66 tests: parser/rewriter + apply_patch detection + end-to-end plugin behaviour
mise run typecheck
```

`mise tasks` lists everything available (`install`, `test`, `typecheck`).

## What's not handled

- The shell parser is a small, test-driven tokenizer for common delete forms
  (`rm`/`rmdir`/`unlink`, `find -delete` / `-exec rm`, `xargs rm`). It is **not** a
  full POSIX shell parser; exotic constructs may slip past detection.
- Custom delete scripts (a wrapper script, a project-specific `bin/clean`, a plugin
  tool with its own deletion verb, …) aren't recognised. The plugin only knows about
  the deletion patterns listed above. Add cases to `parseDeletes` /
  `rewriteRmToTrash` / `parseFileToolDeletes` in [`src/index.ts`](src/index.ts) if
  you want more.
- `apply_patch` deletions are detected and prompted on, but not rewritten — once
  approved, the file is gone for real. Use git or backups if you need recovery.
- `xargs rm` is rewritten to `xargs trash`, but its delete targets come from stdin
  and can't be statically inspected, so they don't contribute to the
  outside-workspace approval check.
