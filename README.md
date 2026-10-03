# DVC Source Control

A VS Code extension that adds a DVC provider to the **Source Control** view. It works like the built-in Git view, but for data tracked by [DVC](https://dvc.org).

## What you get

- **One entry per DVC repository** found in the workspace, including a workspace opened on a sub-folder of the repo, DVC subrepos, and Git worktrees.
- **One group per tracked output**: each folder or file declared in a `.dvc` file or in the `outs` of a `dvc.lock` stage, labelled with where it is declared (for example `data/   data.dvc` or `model.pkl   dvc.lock › train`). Each group lists its pending changes file by file. By default outputs without changes are listed too, so you see everything DVC tracks.
- **Change states**, from `dvc data status --granular`:
  - `A` / `M` / `D` / `R`: changed in the working tree, not yet `dvc commit`ted.
  - Faded entries: committed to the DVC cache, but the `.dvc` / `dvc.lock` file isn't committed in Git yet.
  - `↓`: not in the local cache (needs `dvc pull` / `fetch`).
  - `↑`: not pushed to the remote. Only shown when `dvcScm.checkRemote` is on.
- **Diffs**: click a file to compare the DVC cache with the working tree. For a committed change it compares the Git HEAD version with the cache. Text files also get change markers in the editor gutter. Binary files, such as images, open through the read-only `dvc-cache:` file system.
- **Actions**
  - View title: commit all, refresh, pull / push / fetch, discard all changes, use another worktree's cache.
  - Output (group): commit (`dvc commit`), discard changes (`dvc checkout --force`), pull, push, open the `.dvc` / `dvc.lock` entry, reveal in the Explorer.
  - File: open changes, open file, discard changes (restored from the cache; added files go to the trash), pull, push. You can select several files at once.
- **Explorer badges** that propagate to parent folders, and a status bar item with the counts of files to pull or push.
- **Auto refresh** when files change (debounced; DVC's own `.dvc/` bookkeeping is ignored). All DVC calls for a repository are queued, so they never collide on DVC's repository lock.

## Git worktrees

`.dvc/cache` is git-ignored, so a new worktree starts with no cache: every output then shows as deleted and not in the cache. When the extension detects this, it looks at every other worktree of the same Git repository, including worktrees of a bare repository. It then offers to share the cache of one of them (`dvc cache dir --local <cache>`, followed by `dvc checkout` or `dvc pull`), or simply to pull. The same action is available from the `…` menu as **Use the DVC Cache of Another Git Worktree**.

## Requirements

DVC 3.x. It needs `dvc data status`, which older 2.x releases lack. The extension finds DVC in this order:

1. `dvcScm.executable`, if set. It can be a path, or a command line such as `poetry run dvc`. A `poetry run …` command is resolved once to the executable inside the Poetry virtualenv, because `poetry run` adds seconds to every call.
2. `dvc` on `PATH`.
3. A project `.venv` / `venv` folder, or the Poetry environment of the nearest `pyproject.toml`.

The **DVC** output channel shows which command is used.

## Settings

| Setting | Default | |
|---|---|---|
| `dvcScm.executable` | `dvc` | DVC path or command line, e.g. `poetry run dvc`. |
| `dvcScm.showCleanOutputs` | `true` | List outputs that have no changes. |
| `dvcScm.showCommitted` | `true` | Show changes already committed to the cache but not to Git. |
| `dvcScm.checkRemote` | `false` | Also report files that aren't pushed yet. Contacts the remote on each refresh. |
| `dvcScm.autoRefresh` | `true` | Refresh when files change. |
| `dvcScm.refreshDelay` | `1500` | Debounce delay, in ms. |
| `dvcScm.decorations.enabled` | `true` | Explorer badges and colours. |

## Build and run

```sh
npm install
npm run compile      # or: npm run watch
```

Press **F5** in VS Code to start an Extension Development Host. To build an installable package:

```sh
npm run package      # produces dvc-scm-<version>.vsix
code --install-extension dvc-scm-0.1.0.vsix
```

## License

MIT — see the `LICENSE` file.
