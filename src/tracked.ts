import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parse as parseYaml } from 'yaml';

/** A path tracked by DVC, declared either in a `.dvc` file or in the `outs` of a `dvc.lock` stage. */
export interface TrackedOutput {
  /** Repo-relative POSIX path, without trailing slash. */
  path: string;
  /** Repo-relative POSIX path of the declaring `.dvc` / `dvc.lock` file. */
  dvcFile: string;
  /** Stage name when declared in `dvc.lock`. */
  stage?: string;
  /** Recorded hash (`md5` value); directories end with `.dir`. Undefined when never committed. */
  hash?: string;
  isDir: boolean;
  /** True for DVC 3 hashes (`hash: md5`), stored under `files/md5` in the cache. */
  dvc3: boolean;
  cache: boolean;
}

export const toPosix = (p: string) => p.replace(/\\/g, '/');

export function stripSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

interface RawOut {
  path?: string;
  md5?: string;
  hash?: string;
  cache?: boolean;
}

function toOutput(raw: RawOut, dvcFile: string, stage?: string): TrackedOutput | undefined {
  if (!raw || typeof raw.path !== 'string') {
    return undefined;
  }
  const baseDir = path.posix.dirname(dvcFile);
  const rel = stripSlash(path.posix.normalize(path.posix.join(baseDir, toPosix(raw.path))));
  if (rel.startsWith('..')) {
    return undefined; // outside the repository
  }
  const hash = typeof raw.md5 === 'string' ? raw.md5 : undefined;
  return {
    path: rel,
    dvcFile,
    stage,
    hash,
    isDir: !!hash?.endsWith('.dir'),
    dvc3: raw.hash === 'md5',
    cache: raw.cache !== false,
  };
}

/** Parses the content of a `.dvc` or `dvc.lock` file; `dvcFile` is its repo-relative path. */
export function parseDvcFile(content: string, dvcFile: string): TrackedOutput[] {
  let doc: any;
  try {
    doc = parseYaml(content);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== 'object') {
    return [];
  }
  const result: TrackedOutput[] = [];
  if (path.posix.basename(dvcFile) === 'dvc.lock') {
    for (const [stage, def] of Object.entries<any>(doc.stages ?? {})) {
      for (const out of def?.outs ?? []) {
        const o = toOutput(out, dvcFile, stage);
        if (o) {
          result.push(o);
        }
      }
    }
  } else {
    for (const out of doc.outs ?? []) {
      const o = toOutput(out, dvcFile);
      if (o) {
        result.push(o);
      }
    }
  }
  return result;
}

export async function discoverOutputs(root: string): Promise<TrackedOutput[]> {
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(root, '**/{*.dvc,dvc.lock}'),
    '**/{node_modules,.git,.dvc}/**',
  );
  const outputs: TrackedOutput[] = [];
  await Promise.all(
    files.map(async (uri) => {
      const rel = toPosix(path.relative(root, uri.fsPath));
      try {
        const content = await fs.promises.readFile(uri.fsPath, 'utf8');
        outputs.push(...parseDvcFile(content, rel));
      } catch {
        // file vanished between discovery and read
      }
    }),
  );
  outputs.sort((a, b) => a.path.localeCompare(b.path));
  return outputs;
}

/** Finds the output that owns `relPath` (the output itself, or a file inside a tracked directory). */
export function findOwner(outputs: TrackedOutput[], relPath: string): TrackedOutput | undefined {
  let best: TrackedOutput | undefined;
  for (const o of outputs) {
    if (relPath === o.path || relPath.startsWith(o.path + '/')) {
      if (!best || o.path.length > best.path.length) {
        best = o;
      }
    }
  }
  return best;
}

/** Locates objects in the DVC cache and resolves the hash of a file inside a tracked output. */
export class CacheIndex {
  private dirListings = new Map<string, Map<string, string> | null>();

  constructor(public cacheDir: string) {}

  objectPath(hash: string, dvc3: boolean): string | undefined {
    const rel = [hash.slice(0, 2), hash.slice(2)];
    const candidates = dvc3
      ? [path.join(this.cacheDir, 'files', 'md5', ...rel), path.join(this.cacheDir, ...rel)]
      : [path.join(this.cacheDir, ...rel), path.join(this.cacheDir, 'files', 'md5', ...rel)];
    return candidates.find((c) => fs.existsSync(c));
  }

  private dirListing(hash: string, dvc3: boolean): Map<string, string> | undefined {
    if (!this.dirListings.has(hash)) {
      let listing: Map<string, string> | null = null;
      const file = this.objectPath(hash, dvc3);
      if (file) {
        try {
          const entries = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>[];
          listing = new Map();
          for (const e of entries) {
            const h = e.md5 ?? Object.entries(e).find(([k, v]) => k !== 'relpath' && typeof v === 'string')?.[1];
            if (e.relpath && h) {
              listing.set(toPosix(e.relpath), h);
            }
          }
        } catch {
          listing = null;
        }
      }
      // .dir objects are immutable, so a found listing can be cached forever; a missing one may be pulled later.
      if (listing) {
        this.dirListings.set(hash, listing);
      }
      return listing ?? undefined;
    }
    return this.dirListings.get(hash) ?? undefined;
  }

  /** Hash of `relPath` as recorded by `output`, or undefined if not part of it. */
  hashOf(output: TrackedOutput, relPath: string): string | undefined {
    if (!output.hash) {
      return undefined;
    }
    if (relPath === output.path) {
      return output.isDir ? undefined : output.hash;
    }
    if (!output.isDir) {
      return undefined;
    }
    return this.dirListing(output.hash, output.dvc3)?.get(relPath.slice(output.path.length + 1));
  }

}
