import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { toCacheUri } from './cacheFs';
import { DvcError, DvcRunner, git } from './dvcCli';
import {
  CacheIndex,
  TrackedOutput,
  discoverOutputs,
  findOwner,
  parseDvcFile,
  toPosix,
} from './tracked';

type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';

interface ChangeSet {
  added?: string[];
  modified?: string[];
  deleted?: string[];
  unknown?: string[];
  renamed?: { old: string; new: string }[];
}

/** JSON document printed by `dvc data status --json`. */
interface DataStatus {
  not_in_cache?: string[];
  not_in_remote?: string[];
  committed?: ChangeSet;
  uncommitted?: ChangeSet;
}

/** Everything DVC reports about one file. */
export interface FileStatus {
  relPath: string;
  /** Directory-level entry, reported by DVC when it cannot list the directory's files. */
  isDir?: boolean;
  /** Workspace differs from the .dvc / dvc.lock file. */
  uncommitted?: ChangeKind;
  /** .dvc / dvc.lock file differs from Git HEAD (already committed to the DVC cache). */
  committed?: ChangeKind;
  /** Renamed from, for `renamed` changes. */
  renamedFrom?: string;
  notInCache?: boolean;
  notInRemote?: boolean;
}

const LETTERS: Record<ChangeKind, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', unknown: '?' };

export class DvcResource implements vscode.SourceControlResourceState {
  readonly resourceUri: vscode.Uri;
  readonly command: vscode.Command;
  readonly decorations: vscode.SourceControlResourceDecorations;
  readonly contextValue: string;

  constructor(
    readonly repo: DvcRepository,
    readonly status: FileStatus,
    readonly output: TrackedOutput | undefined,
  ) {
    this.resourceUri = vscode.Uri.file(path.join(repo.root, status.relPath));
    this.command = { title: 'Open Changes', command: 'dvcScm.openChange', arguments: [this] };

    const kind = status.uncommitted ?? status.committed;
    const exists = fs.existsSync(this.resourceUri.fsPath);
    const tooltip: string[] = [];
    if (status.uncommitted) {
      tooltip.push(`${capitalize(status.uncommitted)} in the working tree (not committed to DVC)`);
    }
    if (status.committed) {
      tooltip.push(`${capitalize(status.committed)} in the DVC cache, ${path.basename(output?.dvcFile ?? 'the .dvc file')} not committed in Git`);
    }
    if (status.renamedFrom) {
      tooltip.push(`Renamed from ${status.renamedFrom}`);
    }
    if (status.notInCache) {
      tooltip.push('Not in the local DVC cache (pull or fetch it)');
    }
    if (status.notInRemote) {
      tooltip.push('Not pushed to the DVC remote');
    }

    this.decorations = {
      strikeThrough: kind === 'deleted',
      faded: !status.uncommitted && !!status.committed,
      tooltip: tooltip.join('\n'),
    };
    this.contextValue = [
      status.uncommitted && 'uncommitted',
      status.committed && 'committed',
      kind,
      status.notInCache && 'notInCache',
      status.notInRemote && 'notInRemote',
      exists && !status.isDir && 'exists',
    ]
      .filter(Boolean)
      .join(' ');
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function decorationFor(status: FileStatus): vscode.FileDecoration | undefined {
  const kind = status.uncommitted ?? status.committed;
  if (kind) {
    const color =
      kind === 'added'
        ? 'dvcScm.addedResourceForeground'
        : kind === 'deleted'
          ? 'dvcScm.deletedResourceForeground'
          : 'dvcScm.modifiedResourceForeground';
    const d = new vscode.FileDecoration(LETTERS[kind], `DVC: ${kind}`, new vscode.ThemeColor(color));
    d.propagate = true;
    return d;
  }
  if (status.notInCache) {
    return new vscode.FileDecoration('↓', 'DVC: not in cache', new vscode.ThemeColor('dvcScm.missingResourceForeground'));
  }
  if (status.notInRemote) {
    return new vscode.FileDecoration('↑', 'DVC: not pushed', new vscode.ThemeColor('dvcScm.missingResourceForeground'));
  }
  return undefined;
}

/** `cache.dir` from `.dvc/config.local` or `.dvc/config` (relative to `.dvc/`), else `<root>/.dvc/cache`. */
function configuredCacheDir(dvcRoot: string): string {
  const dvcDir = path.join(dvcRoot, '.dvc');
  for (const name of ['config.local', 'config']) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dvcDir, name), 'utf8');
    } catch {
      continue;
    }
    let inCache = false;
    for (const line of text.split(/\r?\n/)) {
      const section = /^\s*\[\s*'?"?([^\]'"]+)"?'?\s*\]/.exec(line);
      if (section) {
        inCache = section[1].trim() === 'cache';
        continue;
      }
      const dir = inCache && /^\s*dir\s*=\s*(.+?)\s*$/.exec(line);
      if (dir) {
        return path.resolve(dvcDir, dir[1]);
      }
    }
  }
  return path.join(dvcDir, 'cache');
}

export class DvcRepository implements vscode.Disposable {
  readonly sourceControl: vscode.SourceControl;
  readonly runner: DvcRunner;
  readonly cache: CacheIndex;

  private readonly disposables: vscode.Disposable[] = [];
  private groups = new Map<string, vscode.SourceControlResourceGroup>();
  private groupOutputs = new Map<vscode.SourceControlResourceGroup, TrackedOutput>();
  private otherGroup: vscode.SourceControlResourceGroup | undefined;
  private outputs: TrackedOutput[] = [];
  private headOutputs = new Map<string, Promise<TrackedOutput[]>>();
  private statuses = new Map<string, FileStatus>();

  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshing: Promise<void> | undefined;
  private refreshAgain = false;
  private cacheDirStale = true;
  private disposed = false;

  private readonly statusEmitter = new vscode.EventEmitter<void>();
  /** Fires after each refresh. */
  readonly onDidChangeStatus = this.statusEmitter.event;

  /** Repo roots nested inside this one (DVC subrepos), whose files belong to them rather than to us. */
  nestedRoots: string[] = [];

  constructor(
    readonly root: string,
    readonly log: vscode.OutputChannel,
  ) {
    this.runner = new DvcRunner(root, log);
    this.cache = new CacheIndex(path.join(root, '.dvc', 'cache'));

    this.sourceControl = vscode.scm.createSourceControl('dvc', 'DVC', vscode.Uri.file(root));
    this.sourceControl.inputBox.visible = false;
    this.sourceControl.quickDiffProvider = {
      provideOriginalResource: (uri) => this.originalResource(uri),
    };
    this.disposables.push(this.sourceControl, this.statusEmitter);

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**'));
    const onChange = (uri: vscode.Uri) => this.onFileEvent(uri);
    watcher.onDidChange(onChange, null, this.disposables);
    watcher.onDidCreate(onChange, null, this.disposables);
    watcher.onDidDelete(onChange, null, this.disposables);
    this.disposables.push(watcher);

    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration('dvcScm')) {
          this.rebuildGroups(true);
          this.populateGroups();
          this.scheduleRefresh(0);
        }
      },
      null,
      this.disposables,
    );
  }

  get name(): string {
    return path.basename(this.root);
  }

  get fileStatuses(): ReadonlyMap<string, FileStatus> {
    return this.statuses;
  }

  private onFileEvent(uri: vscode.Uri): void {
    const rel = toPosix(path.relative(this.root, uri.fsPath));
    if (rel === '.dvc/config' || rel === '.dvc/config.local') {
      this.cacheDirStale = true;
    } else if (rel.startsWith('.dvc/') || rel.startsWith('.git/') || rel === '.git' || rel.startsWith('..')) {
      // DVC's own bookkeeping (state db, lock, cache) and Git internals: reacting would loop.
      return;
    }
    if (vscode.workspace.getConfiguration('dvcScm').get<boolean>('autoRefresh', true)) {
      this.scheduleRefresh();
    }
  }

  scheduleRefresh(delay?: number): void {
    const ms = delay ?? vscode.workspace.getConfiguration('dvcScm').get<number>('refreshDelay', 1500);
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), ms);
  }

  /** Re-reads outputs and `dvc data status`; concurrent calls coalesce into one extra run. */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        try {
          await this.doRefresh();
        } catch (err) {
          this.log.appendLine(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`);
          this.sourceControl.statusBarCommands = [
            { title: '$(warning) DVC', tooltip: 'DVC status failed. Click to show the log.', command: 'dvcScm.showOutput' },
          ];
        }
      } while (this.refreshAgain && !this.disposed);
      this.refreshing = undefined;
    })();
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const config = vscode.workspace.getConfiguration('dvcScm');
    if (this.cacheDirStale) {
      this.cacheDirStale = false;
      try {
        const { stdout } = await this.runner.run(['cache', 'dir']);
        const dir = stdout.trim().split(/\r?\n/).pop();
        if (dir) {
          this.cache.cacheDir = path.resolve(this.root, dir);
        }
      } catch {
        // keep the default <root>/.dvc/cache
      }
    }

    const outputs = (await discoverOutputs(this.root)).filter(
      (o) => !this.nestedRoots.some((r) => path.join(this.root, o.dvcFile).startsWith(r + path.sep)),
    );

    const args = ['data', 'status', '--granular', '--json'];
    if (config.get<boolean>('checkRemote')) {
      args.push('--not-in-remote');
    }
    const status = await this.runner.json<DataStatus>(args);
    if (this.disposed) {
      return;
    }

    const statuses = new Map<string, FileStatus>();
    // Directory summary lines ("data/"). They are redundant when the directory's files are listed too,
    // but are the only entry when DVC cannot list them (whole output deleted, .dir object not in cache).
    const dirs = new Map<string, FileStatus>();
    const entry = (p: string): FileStatus => {
      const rel = toPosix(p);
      const isDir = rel.endsWith('/');
      const key = isDir ? rel.slice(0, -1) : rel;
      const map = isDir ? dirs : statuses;
      let s = map.get(key);
      if (!s) {
        s = { relPath: key, isDir };
        map.set(key, s);
      }
      return s;
    };
    const applyChanges = (set: ChangeSet | undefined, field: 'uncommitted' | 'committed') => {
      for (const kind of ['added', 'modified', 'deleted', 'unknown'] as const) {
        for (const p of set?.[kind] ?? []) {
          entry(p)[field] = kind;
        }
      }
      for (const r of set?.renamed ?? []) {
        const s = entry(r.new);
        s[field] = 'renamed';
        s.renamedFrom = toPosix(r.old);
      }
    };
    applyChanges(status.uncommitted, 'uncommitted');
    if (config.get<boolean>('showCommitted', true)) {
      applyChanges(status.committed, 'committed');
    }
    for (const p of status.not_in_cache ?? []) {
      entry(p).notInCache = true;
    }
    for (const p of status.not_in_remote ?? []) {
      entry(p).notInRemote = true;
    }
    const files = [...statuses.keys()];
    for (const [dir, s] of dirs) {
      if (!files.some((f) => f.startsWith(dir + '/'))) {
        statuses.set(dir, s);
      }
    }

    this.outputs = outputs;
    this.statuses = statuses;
    this.headOutputs.clear();
    this.rebuildGroups(this.otherGroup === undefined);
    this.populateGroups();
    this.statusEmitter.fire();
  }

  /** Recreates the resource groups when the set of tracked outputs changed (keeps them sorted). */
  private rebuildGroups(force: boolean): void {
    const keys = this.outputs.map((o) => `out:${o.path}`);
    const unchanged = keys.length === this.groups.size && keys.every((k) => this.groups.has(k));
    if (unchanged && !force) {
      return;
    }
    for (const g of this.groups.values()) {
      g.dispose();
    }
    this.otherGroup?.dispose();
    this.groups.clear();
    this.groupOutputs.clear();

    const hideClean = !vscode.workspace.getConfiguration('dvcScm').get<boolean>('showCleanOutputs', true);
    for (const o of this.outputs) {
      const key = `out:${o.path}`;
      if (this.groups.has(key)) {
        continue; // same path declared twice: DVC itself reports that as an error
      }
      const origin = o.stage ? `${o.dvcFile} › ${o.stage}` : o.dvcFile;
      const g = this.sourceControl.createResourceGroup(key, `${o.path}${o.isDir ? '/' : ''}   ${origin}`);
      g.hideWhenEmpty = hideClean;
      this.groups.set(key, g);
      this.groupOutputs.set(g, o);
    }
    this.otherGroup = this.sourceControl.createResourceGroup('other', 'Other');
    this.otherGroup.hideWhenEmpty = true;
  }

  private populateGroups(): void {
    const byGroup = new Map<vscode.SourceControlResourceGroup, DvcResource[]>();
    let changes = 0;
    let toPull = 0;
    let toPush = 0;
    for (const s of this.statuses.values()) {
      const owner = findOwner(this.outputs, s.relPath);
      const group = (owner && this.groups.get(`out:${owner.path}`)) || this.otherGroup!;
      let list = byGroup.get(group);
      if (!list) {
        list = [];
        byGroup.set(group, list);
      }
      list.push(new DvcResource(this, s, owner));
      if (s.uncommitted || s.committed) {
        changes++;
      }
      toPull += s.notInCache ? 1 : 0;
      toPush += s.notInRemote ? 1 : 0;
    }
    for (const g of [...this.groups.values(), this.otherGroup!]) {
      g.resourceStates = (byGroup.get(g) ?? []).sort((a, b) => a.status.relPath.localeCompare(b.status.relPath));
    }
    this.sourceControl.count = changes;

    const sync: vscode.Command = {
      title: `$(database) ${[toPull && `${toPull}↓`, toPush && `${toPush}↑`].filter(Boolean).join(' ') || 'DVC'}`,
      tooltip: `DVC — ${toPull} file(s) not in the local cache${
        vscode.workspace.getConfiguration('dvcScm').get<boolean>('checkRemote') ? `, ${toPush} not pushed` : ''
      }. Click to pull.`,
      command: 'dvcScm.pull',
      arguments: [this.sourceControl],
    };
    this.sourceControl.statusBarCommands = [sync];
  }

  outputOfGroup(group: vscode.SourceControlResourceGroup): TrackedOutput | undefined {
    return this.groupOutputs.get(group);
  }

  ownsGroup(group: vscode.SourceControlResourceGroup): boolean {
    return this.groupOutputs.has(group) || group === this.otherGroup;
  }

  getOutputs(): readonly TrackedOutput[] {
    return this.outputs;
  }

  relative(uri: vscode.Uri): string | undefined {
    const rel = toPosix(path.relative(this.root, uri.fsPath));
    return rel.startsWith('..') || path.isAbsolute(rel) ? undefined : rel;
  }

  // ---------------------------------------------------------------- diffs

  /** Outputs recorded in Git HEAD for a given .dvc / dvc.lock file. */
  private headOutputsOf(dvcFile: string): Promise<TrackedOutput[]> {
    let p = this.headOutputs.get(dvcFile);
    if (!p) {
      p = git(['show', `HEAD:./${dvcFile}`], this.root, this.log).then(
        (r) => parseDvcFile(r.stdout, dvcFile),
        () => [] as TrackedOutput[],
      );
      this.headOutputs.set(dvcFile, p);
    }
    return p;
  }

  private cacheUriFor(file: vscode.Uri, output: TrackedOutput | undefined, relPath: string, label: string): vscode.Uri {
    const hash = output && this.cache.hashOf(output, relPath);
    const object = hash && output ? this.cache.objectPath(hash, output.dvc3) : undefined;
    return toCacheUri(file, object, label);
  }

  private originalResource(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const rel = this.relative(uri);
    const owner = rel !== undefined ? findOwner(this.outputs, rel) : undefined;
    if (!owner || rel === undefined || !this.cache.hashOf(owner, rel)) {
      return undefined;
    }
    return this.cacheUriFor(uri, owner, rel, 'DVC');
  }

  async openChange(res: DvcResource): Promise<void> {
    const { status, output, resourceUri } = res;
    const name = path.basename(status.relPath);
    const opts: vscode.TextDocumentShowOptions = { preview: true };

    if (status.isDir) {
      if (fs.existsSync(resourceUri.fsPath)) {
        await vscode.commands.executeCommand('revealInExplorer', resourceUri);
      }
      return;
    }

    if (status.uncommitted) {
      const cached = this.cacheUriFor(resourceUri, output, status.renamedFrom ?? status.relPath, 'DVC');
      switch (status.uncommitted) {
        case 'added':
          return void vscode.commands.executeCommand('vscode.open', resourceUri, opts);
        case 'deleted':
          return void vscode.commands.executeCommand('vscode.open', cached, opts, `${name} (Deleted)`);
        default:
          return void vscode.commands.executeCommand(
            'vscode.diff',
            cached,
            resourceUri,
            `${name} (DVC Cache ↔ Working Tree)`,
            opts,
          );
      }
    }

    if (status.committed && output) {
      const current = this.cacheUriFor(resourceUri, output, status.relPath, 'DVC');
      const headOut = (await this.headOutputsOf(output.dvcFile)).find((o) => o.path === output.path);
      const head = this.cacheUriFor(resourceUri, headOut, status.renamedFrom ?? status.relPath, 'HEAD');
      switch (status.committed) {
        case 'added':
          return void vscode.commands.executeCommand('vscode.open', current, opts, `${name} (Added)`);
        case 'deleted':
          return void vscode.commands.executeCommand('vscode.open', head, opts, `${name} (Deleted)`);
        default:
          return void vscode.commands.executeCommand('vscode.diff', head, current, `${name} (HEAD ↔ DVC Cache)`, opts);
      }
    }

    if (fs.existsSync(resourceUri.fsPath)) {
      await vscode.commands.executeCommand('vscode.open', resourceUri, opts);
    }
  }

  // ---------------------------------------------------------------- operations

  /** Runs a dvc command with progress, reports failures, then refreshes. */
  async run(
    title: string,
    args: string[],
    location: vscode.ProgressLocation = vscode.ProgressLocation.SourceControl,
  ): Promise<boolean> {
    try {
      await vscode.window.withProgress(
        { location, title, cancellable: location === vscode.ProgressLocation.Notification },
        (_progress, token) => this.runner.run(args, token),
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const choice = await vscode.window.showErrorMessage(message, 'Show Output');
      if (choice) {
        this.log.show();
      }
      return false;
    } finally {
      this.scheduleRefresh(0);
    }
  }

  // ---------------------------------------------------------------- git worktrees

  /**
   * `.dvc/cache` is git-ignored, so a new Git worktree starts without a cache and every tracked file
   * shows as deleted / not in cache. Lists the caches of the other worktrees of the same Git repository
   * (main or linked, including the bare-repository layout), for this repository's sub-folder.
   */
  async worktreeCaches(): Promise<{ worktree: string; cache: string }[]> {
    let porcelain: string;
    let prefix: string;
    try {
      const out = (a: string[]) => git(a, this.root, this.log).then((r) => r.stdout);
      porcelain = await out(['worktree', 'list', '--porcelain']);
      prefix = (await out(['rev-parse', '--show-prefix'])).trim();
    } catch (err) {
      if (err instanceof DvcError) {
        return []; // not a Git repository
      }
      throw err;
    }
    const own = path.resolve(this.cache.cacheDir).toLowerCase();
    const seen = new Set<string>();
    const result: { worktree: string; cache: string }[] = [];
    for (const block of porcelain.split(/\r?\n\r?\n/)) {
      const wt = /^worktree (.+)$/m.exec(block)?.[1];
      if (!wt || /^bare$/m.test(block)) {
        continue;
      }
      const dvcRoot = path.resolve(wt, prefix);
      if (path.resolve(dvcRoot).toLowerCase() === path.resolve(this.root).toLowerCase()) {
        continue;
      }
      const cache = configuredCacheDir(dvcRoot);
      const key = path.resolve(cache).toLowerCase();
      if (cache && key !== own && !seen.has(key) && fs.existsSync(cache)) {
        seen.add(key);
        result.push({ worktree: wt, cache: path.resolve(cache) });
      }
    }
    return result;
  }

  isCacheMissing(): boolean {
    return !fs.existsSync(this.cache.cacheDir);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.refreshTimer);
    for (const g of this.groups.values()) {
      g.dispose();
    }
    this.otherGroup?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

