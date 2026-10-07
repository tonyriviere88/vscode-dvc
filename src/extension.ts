import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CACHE_SCHEME, CacheFileSystemProvider } from './cacheFs';
import { DvcDecorationProvider } from './decorations';
import { clearDvcCommandCache } from './dvcCli';
import { getGitApi, isInside, watchGitHead, whenGitRepositoryOpen } from './gitHead';
import { DvcRepository, DvcResource } from './repository';
import { TrackedOutput } from './tracked';

const repos = new Map<string, DvcRepository>();
let log: vscode.OutputChannel;
let decorations: DvcDecorationProvider;
let context: vscode.ExtensionContext;
let git: ReturnType<typeof getGitApi>;

/** API returned to other extensions (and tests). */
export interface DvcScmApi {
  repositories(): DvcRepository[];
}

export async function activate(ctx: vscode.ExtensionContext): Promise<DvcScmApi> {
  context = ctx;
  log = vscode.window.createOutputChannel('DVC');
  decorations = new DvcDecorationProvider();
  ctx.subscriptions.push(
    log,
    decorations,
    vscode.workspace.registerFileSystemProvider(CACHE_SCHEME, new CacheFileSystemProvider(), {
      isReadonly: true,
      isCaseSensitive: process.platform === 'linux',
    }),
    { dispose: () => [...repos.values()].forEach((r) => r.dispose()) },
  );

  registerCommands(ctx);
  git = getGitApi(log);

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => void discover()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dvcScm.executable')) {
        clearDvcCommandCache();
      }
      if (e.affectsConfiguration('dvcScm.decorations')) {
        decorations.refreshAll();
      }
    }),
  );
  // `dvc init` / `dvc destroy` while the workspace is open.
  const configWatcher = vscode.workspace.createFileSystemWatcher('**/.dvc/config');
  configWatcher.onDidCreate(() => void discover());
  configWatcher.onDidDelete(() => void discover());
  ctx.subscriptions.push(configWatcher);

  await discover();

  // A Git commit / checkout only writes inside .git/, which the repositories' file watchers ignore.
  void git.then((api) => {
    if (api) {
      ctx.subscriptions.push(
        watchGitHead(api, (gitRoot) => {
          for (const repo of repos.values()) {
            if (isInside(repo.root, gitRoot)) {
              repo.scheduleRefresh(0);
            }
          }
        }),
      );
    }
  });
  return { repositories: () => [...repos.values()] };
}

export function deactivate(): void {
  // disposed through context.subscriptions
}

// ------------------------------------------------------------------ discovery

function isDvcRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.dvc', 'config'));
}

async function findRoots(): Promise<string[]> {
  const roots = new Set<string>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') {
      continue;
    }
    // The folder itself or one of its parents (workspace opened on a sub-folder of the repo).
    for (let dir = folder.uri.fsPath; ; dir = path.dirname(dir)) {
      if (isDvcRoot(dir)) {
        roots.add(dir);
        break;
      }
      if (path.dirname(dir) === dir) {
        break;
      }
    }
    // Repositories (or DVC subrepos) below the folder.
    const configs = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/.dvc/config'),
      '**/node_modules/**',
    );
    for (const c of configs) {
      roots.add(path.dirname(path.dirname(c.fsPath)));
    }
  }
  return [...roots];
}

async function discover(): Promise<void> {
  const roots = await findRoots();
  // Register after Git so that Git stays the default repository in the Source Control view.
  const api = await git;
  if (api) {
    await Promise.all(roots.filter((r) => !repos.has(r)).map((r) => whenGitRepositoryOpen(api, r)));
  }
  for (const [root, repo] of repos) {
    if (!roots.includes(root)) {
      decorations.remove(repo);
      repo.dispose();
      repos.delete(root);
    }
  }
  for (const root of roots) {
    if (!repos.has(root)) {
      const repo = new DvcRepository(root, log);
      repo.onDidChangeStatus(() => decorations.update(repo));
      repos.set(root, repo);
      void repo.refresh().then(() => offerWorktreeCache(repo));
    }
  }
  for (const repo of repos.values()) {
    repo.nestedRoots = [...repos.keys()].filter((r) => r !== repo.root && r.startsWith(repo.root + path.sep));
  }
  void vscode.commands.executeCommand('setContext', 'dvcScm.hasRepositories', repos.size > 0);
}

/** Lets the user pick the cache of another worktree; undefined when cancelled or none exists. */
async function chooseWorktreeCache(repo: DvcRepository): Promise<string | undefined> {
  const caches = await repo.worktreeCaches();
  if (caches.length <= 1) {
    return caches[0]?.cache;
  }
  const pick = await vscode.window.showQuickPick(
    caches.map((c) => ({ label: path.basename(c.worktree), description: c.cache, cache: c.cache })),
    { placeHolder: `DVC cache to use for "${repo.name}"` },
  );
  return pick?.cache;
}

/** In a Git worktree without a DVC cache, propose to reuse another worktree's cache (or to pull). */
async function offerWorktreeCache(repo: DvcRepository): Promise<void> {
  const key = `dvcScm.worktreeCache.dismissed:${repo.root}`;
  if (context.workspaceState.get<boolean>(key) || !repo.isCacheMissing()) {
    return;
  }
  const caches = await repo.worktreeCaches();
  if (!caches.length) {
    return;
  }
  const use = caches.length === 1 ? `Use Cache of "${path.basename(caches[0].worktree)}"` : 'Use Cache of Another Worktree…';
  const pull = 'Pull';
  const never = "Don't Ask Again";
  const choice = await vscode.window.showInformationMessage(
    `"${repo.name}" has no DVC cache, so its tracked data is missing. Share the cache of another Git worktree, or pull from the remote?`,
    use,
    pull,
    never,
  );
  if (choice === use) {
    const cache = await chooseWorktreeCache(repo);
    if (cache) {
      await shareCache(repo, cache);
    }
  } else if (choice === pull) {
    await repo.run(`DVC pull (${repo.name})`, ['pull'], vscode.ProgressLocation.Notification);
  } else if (choice === never) {
    await context.workspaceState.update(key, true);
  }
}

async function shareCache(repo: DvcRepository, cache: string): Promise<void> {
  if (!(await repo.run('Configuring DVC cache', ['cache', 'dir', '--local', cache]))) {
    return;
  }
  const checkout = 'Checkout Now';
  const pull = 'Pull';
  const choice = await vscode.window.showInformationMessage(
    `DVC cache of "${repo.name}" set to ${cache} (in .dvc/config.local). Check out the tracked data now? Pull also downloads what that cache lacks.`,
    checkout,
    pull,
  );
  if (choice) {
    await repo.run(
      choice === pull ? 'DVC pull' : 'Checking out DVC data',
      [choice === pull ? 'pull' : 'checkout'],
      vscode.ProgressLocation.Notification,
    );
  }
}

// ------------------------------------------------------------------ argument resolution

type Arg = unknown;

function repoFromSourceControl(arg: Arg): DvcRepository | undefined {
  const rootUri = (arg as vscode.SourceControl | undefined)?.rootUri;
  return rootUri ? repos.get(rootUri.fsPath) : undefined;
}

async function pickRepo(arg?: Arg): Promise<DvcRepository | undefined> {
  const fromArg = repoFromSourceControl(arg);
  if (fromArg) {
    return fromArg;
  }
  const all = [...repos.values()];
  if (all.length <= 1) {
    if (!all.length) {
      vscode.window.showWarningMessage('No DVC repository found in the workspace.');
    }
    return all[0];
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  const fromEditor = active && all.find((r) => r.relative(active) !== undefined);
  if (fromEditor) {
    return fromEditor;
  }
  const pick = await vscode.window.showQuickPick(
    all.map((r) => ({ label: r.name, description: r.root, repo: r })),
    { placeHolder: 'Choose a DVC repository' },
  );
  return pick?.repo;
}

function groupOutput(arg: Arg): { repo: DvcRepository; output: TrackedOutput } | undefined {
  const group = arg as vscode.SourceControlResourceGroup;
  for (const repo of repos.values()) {
    const output = repo.outputOfGroup(group);
    if (output) {
      return { repo, output };
    }
  }
  return undefined;
}

/** Resource commands receive (clicked, selected[]) — or the arguments of the resource's own command. */
function resources(args: Arg[]): DvcResource[] {
  const flat = args.flatMap((a) => (Array.isArray(a) ? a : [a]));
  const unique = new Set(flat.filter((a): a is DvcResource => a instanceof DvcResource));
  return [...unique];
}

function byRepo(res: DvcResource[]): Map<DvcRepository, DvcResource[]> {
  const m = new Map<DvcRepository, DvcResource[]>();
  for (const r of res) {
    m.set(r.repo, [...(m.get(r.repo) ?? []), r]);
  }
  return m;
}

// ------------------------------------------------------------------ commands

function registerCommands(ctx: vscode.ExtensionContext): void {
  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const notif = vscode.ProgressLocation.Notification;

  reg('dvcScm.showOutput', () => log.show());

  reg('dvcScm.refresh', async (arg?: Arg) => {
    const repo = repoFromSourceControl(arg);
    await Promise.all((repo ? [repo] : [...repos.values()]).map((r) => r.refresh()));
  });

  reg('dvcScm.commitAll', async (arg?: Arg) => {
    const repo = await pickRepo(arg);
    await repo?.run(`Committing all changes of ${repo.name} to the DVC cache`, ['commit', '--force']);
  });

  reg('dvcScm.checkoutAll', async (arg?: Arg) => {
    const repo = await pickRepo(arg);
    if (!repo) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Discard all uncommitted changes in the DVC-tracked outputs of "${repo.name}"?`,
      { modal: true, detail: 'Files are restored from the DVC cache (dvc checkout --force). This cannot be undone.' },
      'Discard All Changes',
    );
    if (ok) {
      await repo.run('Discarding DVC changes', ['checkout', '--force']);
    }
  });

  reg('dvcScm.push', async (arg?: Arg) => {
    const repo = await pickRepo(arg);
    await repo?.run(`DVC push (${repo.name})`, ['push'], notif);
  });
  reg('dvcScm.pull', async (arg?: Arg) => {
    const repo = await pickRepo(arg);
    await repo?.run(`DVC pull (${repo.name})`, ['pull'], notif);
  });
  reg('dvcScm.fetch', async (arg?: Arg) => {
    const repo = await pickRepo(arg);
    await repo?.run(`DVC fetch (${repo.name})`, ['fetch'], notif);
  });

  reg('dvcScm.shareWorktreeCache', async (arg?: Arg) => {
    const repo = await pickRepo(arg);
    if (!repo) {
      return;
    }
    if (!(await repo.worktreeCaches()).length) {
      vscode.window.showInformationMessage(`No other Git worktree of "${repo.name}" has a DVC cache to share.`);
      return;
    }
    const cache = await chooseWorktreeCache(repo);
    if (cache) {
      await shareCache(repo, cache);
    }
  });

  // ---- per tracked output (resource group)

  reg('dvcScm.commitOutput', async (group: Arg) => {
    const g = groupOutput(group);
    // For stage outputs the target must be the stage, for .dvc files the .dvc file.
    const target = g?.output.stage ? `${g.output.dvcFile.replace(/dvc\.lock$/, 'dvc.yaml')}:${g.output.stage}` : g?.output.dvcFile;
    if (g && target) {
      await g.repo.run(`Committing ${g.output.path} to the DVC cache`, ['commit', '--force', target]);
    }
  });

  reg('dvcScm.checkoutOutput', async (group: Arg) => {
    const g = groupOutput(group);
    if (!g) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Discard all uncommitted changes in "${g.output.path}"?`,
      { modal: true, detail: 'The output is restored from the DVC cache (dvc checkout --force). This cannot be undone.' },
      'Discard Changes',
    );
    if (ok) {
      await g.repo.run(`Restoring ${g.output.path}`, ['checkout', '--force', g.output.path]);
    }
  });

  reg('dvcScm.pushOutput', async (group: Arg) => {
    const g = groupOutput(group);
    await g?.repo.run(`DVC push ${g.output.path}`, ['push', g.output.path], notif);
  });

  reg('dvcScm.pullOutput', async (group: Arg) => {
    const g = groupOutput(group);
    await g?.repo.run(`DVC pull ${g.output.path}`, ['pull', g.output.path], notif);
  });

  reg('dvcScm.openDvcFile', async (group: Arg) => {
    const g = groupOutput(group);
    if (!g) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(path.join(g.repo.root, g.output.dvcFile));
    const editor = await vscode.window.showTextDocument(doc);
    // Jump to the output's entry.
    const text = doc.getText();
    const name = path.posix.relative(path.posix.dirname(g.output.dvcFile), g.output.path);
    const needle = g.output.stage ? `${g.output.stage}:` : `path: ${name}`;
    const offset = text.indexOf(needle);
    if (offset >= 0) {
      const pos = doc.positionAt(offset);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  });

  reg('dvcScm.revealOutput', async (group: Arg) => {
    const g = groupOutput(group);
    if (g) {
      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(path.join(g.repo.root, g.output.path)));
    }
  });

  // ---- per file (resource state)

  reg('dvcScm.openChange', async (...args: Arg[]) => {
    for (const r of resources(args)) {
      await r.repo.openChange(r);
    }
  });

  reg('dvcScm.openFile', async (...args: Arg[]) => {
    for (const r of resources(args)) {
      if (fs.existsSync(r.resourceUri.fsPath)) {
        await vscode.commands.executeCommand('vscode.open', r.resourceUri);
      }
    }
  });

  reg('dvcScm.checkoutResource', async (...args: Arg[]) => {
    const res = resources(args).filter((r) => r.status.uncommitted);
    if (!res.length) {
      return;
    }
    const added = res.filter((r) => r.status.uncommitted === 'added');
    const restored = res.filter((r) => r.status.uncommitted !== 'added');
    const what = res.length === 1 ? `"${path.basename(res[0].status.relPath)}"` : `${res.length} files`;
    const ok = await vscode.window.showWarningMessage(
      `Discard changes in ${what}?`,
      {
        modal: true,
        detail: [
          restored.length ? 'Modified and deleted files are restored from the DVC cache.' : '',
          added.length ? 'Added files are moved to the trash.' : '',
        ]
          .filter(Boolean)
          .join(' '),
      },
      'Discard Changes',
    );
    if (!ok) {
      return;
    }
    for (const r of added) {
      await vscode.workspace.fs.delete(r.resourceUri, { useTrash: true });
    }
    for (const [repo, list] of byRepo(restored)) {
      await repo.run('Restoring from the DVC cache', ['checkout', '--force', ...list.map((r) => r.status.relPath)]);
    }
    for (const repo of new Set(added.map((r) => r.repo))) {
      repo.scheduleRefresh(0);
    }
  });

  reg('dvcScm.pullResource', async (...args: Arg[]) => {
    for (const [repo, list] of byRepo(resources(args))) {
      await repo.run('DVC pull', ['pull', ...list.map((r) => r.status.relPath)], notif);
    }
  });

  reg('dvcScm.pushResource', async (...args: Arg[]) => {
    for (const [repo, list] of byRepo(resources(args))) {
      await repo.run('DVC push', ['push', ...list.map((r) => r.status.relPath)], notif);
    }
  });
}
