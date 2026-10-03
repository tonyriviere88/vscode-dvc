import * as fs from 'fs';
import * as vscode from 'vscode';

export const CACHE_SCHEME = 'dvc-cache';

interface CacheQuery {
  /** Absolute path of the object in the DVC cache; empty when the object does not exist. */
  object: string;
  label: string;
}

/**
 * Builds a URI showing a DVC cache object as if it were `file`, so the editor picks
 * the language and the diff title from the real file name.
 */
export function toCacheUri(file: vscode.Uri, object: string | undefined, label: string): vscode.Uri {
  const query: CacheQuery = { object: object ?? '', label };
  return file.with({ scheme: CACHE_SCHEME, query: JSON.stringify(query) });
}

/** Read-only file system serving DVC cache objects (works for binary files such as images too). */
export class CacheFileSystemProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  private object(uri: vscode.Uri): string {
    try {
      return (JSON.parse(uri.query) as CacheQuery).object;
    } catch {
      return '';
    }
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const object = this.object(uri);
    if (!object) {
      // Missing object: present it as an empty file so a diff still opens.
      return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0, permissions: vscode.FilePermission.Readonly };
    }
    try {
      const s = fs.statSync(object);
      return {
        type: vscode.FileType.File,
        ctime: s.ctimeMs,
        mtime: s.mtimeMs,
        size: s.size,
        permissions: vscode.FilePermission.Readonly,
      };
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const object = this.object(uri);
    if (!object) {
      return new Uint8Array();
    }
    try {
      return fs.readFileSync(object);
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  writeFile(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}
