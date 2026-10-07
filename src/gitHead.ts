import * as path from 'path';
import * as vscode from 'vscode';

/** The part of the built-in Git extension's API (extensions/git/src/api/git.d.ts) used here. */
interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD: { readonly name?: string; readonly commit?: string } | undefined;
    readonly onDidChange: vscode.Event<void>;
  };
}

interface GitApi {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
}

interface GitExtension {
  getAPI(version: 1): GitApi;
}

/** The built-in Git extension's API, or undefined when it is missing or disabled (`git.enabled`). */
export async function getGitApi(log: vscode.OutputChannel): Promise<GitApi | undefined> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) {
    return undefined;
  }
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate();
    return exports.getAPI(1);
  } catch (err) {
    log.appendLine(`Git extension unavailable, Git commits won't refresh the DVC status: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Calls `onHeadChange` with the Git repository root whenever its HEAD moves (commit, checkout, reset, pull…).
 * Those only write inside `.git/`, which the DVC file watcher ignores, yet they change what
 * `dvc data status` reports as committed. Only HEAD is compared: `state.onDidChange` also fires on every
 * Git status run, including those caused by DVC's own refreshes.
 */
export function watchGitHead(api: GitApi, onHeadChange: (gitRoot: string) => void): vscode.Disposable {
  const watched = new Map<GitRepository, vscode.Disposable>();
  const headOf = (r: GitRepository) => `${r.state.HEAD?.name ?? ''}@${r.state.HEAD?.commit ?? ''}`;

  const watch = (r: GitRepository) => {
    if (watched.has(r)) {
      return;
    }
    let head = headOf(r);
    watched.set(
      r,
      r.state.onDidChange(() => {
        const now = headOf(r);
        if (now !== head) {
          head = now;
          onHeadChange(r.rootUri.fsPath);
        }
      }),
    );
  };

  api.repositories.forEach(watch);
  const opened = api.onDidOpenRepository(watch);
  const closed = api.onDidCloseRepository((r) => {
    watched.get(r)?.dispose();
    watched.delete(r);
  });
  return {
    dispose: () => {
      opened.dispose();
      closed.dispose();
      watched.forEach((d) => d.dispose());
      watched.clear();
    },
  };
}

/**
 * Resolves once Git has opened the repository containing `dir`, or has finished its initial scan without
 * one, or after `timeoutMs`. VS Code makes the first registered of two source controls with the same root
 * the active one, so creating the DVC source control after Git's keeps Git the default repository.
 */
export function whenGitRepositoryOpen(api: GitApi, dir: string, timeoutMs = 10000): Promise<void> {
  const ready = () => api.state === 'initialized' || api.repositories.some((r) => isInside(dir, r.rootUri.fsPath));
  if (ready()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      opened.dispose();
      changed.dispose();
      resolve();
    };
    const check = () => ready() && done();
    const timer = setTimeout(done, timeoutMs);
    const opened = api.onDidOpenRepository(check);
    const changed = api.onDidChangeState(check);
  });
}

/** Whether `dir` is `root` or below it. */
export function isInside(dir: string, root: string): boolean {
  const rel = path.relative(root, dir);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}
