import * as path from 'path';
import * as vscode from 'vscode';
import { DvcRepository, decorationFor } from './repository';

/** Explorer (and Source Control view) badges for files with DVC changes, across all repositories. */
export class DvcDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  private perRepo = new Map<DvcRepository, Map<string, vscode.FileDecoration>>();
  private readonly registration: vscode.Disposable;

  constructor() {
    this.registration = vscode.window.registerFileDecorationProvider(this);
  }

  private get enabled(): boolean {
    return vscode.workspace.getConfiguration('dvcScm').get<boolean>('decorations.enabled', true);
  }

  update(repo: DvcRepository): void {
    const previous = this.perRepo.get(repo) ?? new Map();
    const next = new Map<string, vscode.FileDecoration>();
    for (const s of repo.fileStatuses.values()) {
      const d = decorationFor(s);
      if (d) {
        next.set(vscode.Uri.file(path.join(repo.root, s.relPath)).toString(), d);
      }
    }
    this.perRepo.set(repo, next);
    const changed = new Set([...previous.keys(), ...next.keys()]);
    this.emitter.fire([...changed].map((u) => vscode.Uri.parse(u)));
  }

  remove(repo: DvcRepository): void {
    const previous = this.perRepo.get(repo);
    this.perRepo.delete(repo);
    if (previous?.size) {
      this.emitter.fire([...previous.keys()].map((u) => vscode.Uri.parse(u)));
    }
  }

  refreshAll(): void {
    this.emitter.fire([...this.perRepo.values()].flatMap((m) => [...m.keys()].map((u) => vscode.Uri.parse(u))));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file' || !this.enabled) {
      return undefined;
    }
    const key = uri.toString();
    for (const m of this.perRepo.values()) {
      const d = m.get(key);
      if (d) {
        return d;
      }
    }
    return undefined;
  }

  dispose(): void {
    this.registration.dispose();
    this.emitter.dispose();
  }
}
