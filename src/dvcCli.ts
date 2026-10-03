import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export class DvcError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Quote an argument for cmd.exe, which is used on Windows so that dvc.cmd / dvc.bat shims resolve. */
function quoteWin(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

export function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  log: vscode.OutputChannel,
  token?: vscode.CancellationToken,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const display = `${executable} ${args.join(' ')}`;
    log.appendLine(`> ${display}   [${cwd}]`);

    const child = isWin
      ? spawn(quoteWin(executable), args.map(quoteWin), { cwd, shell: true, windowsHide: true })
      : spawn(executable, args, { cwd });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));

    const cancel = token?.onCancellationRequested(() => child.kill());

    child.on('error', (err) => {
      cancel?.dispose();
      log.appendLine(`  ! ${err.message}`);
      reject(new DvcError(`Failed to run "${executable}": ${err.message}`, '', null));
    });
    child.on('close', (code) => {
      cancel?.dispose();
      if (stderr.trim()) {
        log.appendLine(stderr.trimEnd());
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const firstError =
          stderr
            .split(/\r?\n/)
            .find((l) => /^ERROR/i.test(l.trim()))
            ?.trim() ?? stderr.trim().split(/\r?\n/).pop() ?? '';
        reject(new DvcError(`"${display}" failed (exit ${code}). ${firstError}`, stderr, code));
      }
    });
  });
}

/** Splits a command line on whitespace, honouring double quotes: `"C:/My Tools/dvc.exe" --verbose`. */
export function splitCommandLine(line: string): string[] {
  const tokens: string[] = [];
  for (const m of line.matchAll(/"([^"]*)"|(\S+)/g)) {
    tokens.push(m[1] ?? m[2]);
  }
  return tokens;
}

const EXE_SUFFIXES = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];

function findInDir(dir: string, name: string): string | undefined {
  return EXE_SUFFIXES.map((ext) => path.join(dir, name + ext)).find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
}

function onPath(name: string): boolean {
  return (process.env.PATH ?? '').split(path.delimiter).some((d) => d && findInDir(d, name));
}

function venvBin(venv: string): string {
  return path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin');
}

/** Nearest directory at or above `dir` that contains `file`. */
function findUp(dir: string, file: string): string | undefined {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, file))) {
      return d;
    }
    if (path.dirname(d) === d) {
      return undefined;
    }
  }
}

/** Virtualenv Poetry uses for the project containing `cwd`, if any. */
async function poetryEnv(cwd: string, log: vscode.OutputChannel): Promise<string | undefined> {
  try {
    const { stdout } = await runProcess('poetry', ['env', 'info', '--path'], cwd, log);
    const venv = stdout.trim().split(/\r?\n/).pop();
    return venv && fs.existsSync(venv) ? venv : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turns the `dvcScm.executable` setting into the program and leading arguments to spawn.
 * - an existing file path is used as is (spaces allowed);
 * - `poetry run dvc ...` is resolved once to the dvc of the Poetry virtualenv, since `poetry run`
 *   costs seconds per call; it falls back to `poetry run` when the env cannot be found;
 * - the default `dvc`, when not on PATH, is looked up in the project's `.venv` / `venv` or Poetry env.
 */
export async function resolveDvcCommand(setting: string, cwd: string, log: vscode.OutputChannel): Promise<string[]> {
  const value = setting.trim() || 'dvc';
  if (fs.existsSync(value) && fs.statSync(value).isFile()) {
    return [value];
  }
  const tokens = splitCommandLine(value);

  if (tokens[0] === 'poetry' && tokens[1] === 'run' && tokens.length > 2) {
    const venv = await poetryEnv(cwd, log);
    const exe = venv && findInDir(venvBin(venv), tokens[2]);
    return exe ? [exe, ...tokens.slice(3)] : tokens;
  }

  if (tokens.length === 1 && tokens[0] === 'dvc' && !onPath('dvc')) {
    for (const name of ['.venv', 'venv']) {
      const dir = findUp(cwd, name);
      const exe = dir && findInDir(venvBin(path.join(dir, name)), 'dvc');
      if (exe) {
        return [exe];
      }
    }
    if (findUp(cwd, 'pyproject.toml')) {
      const venv = await poetryEnv(cwd, log);
      const exe = venv && findInDir(venvBin(venv), 'dvc');
      if (exe) {
        return [exe];
      }
    }
  }
  return tokens;
}

const resolved = new Map<string, Promise<string[]>>();

/** Resolved dvc command for a directory, cached until the setting changes. */
export function dvcCommand(cwd: string, log: vscode.OutputChannel): Promise<string[]> {
  const setting = vscode.workspace.getConfiguration('dvcScm').get<string>('executable') || 'dvc';
  const key = `${setting}|${cwd}`;
  let cmd = resolved.get(key);
  if (!cmd) {
    cmd = resolveDvcCommand(setting, cwd, log).then((c) => {
      log.appendLine(`Using DVC command for ${cwd}: ${c.join(' ')}`);
      return c;
    });
    resolved.set(key, cmd);
  }
  return cmd;
}

export function clearDvcCommandCache(): void {
  resolved.clear();
}

/** Runs dvc once in `cwd`, outside any repository queue. */
export async function runDvc(args: string[], cwd: string, log: vscode.OutputChannel): Promise<RunResult> {
  const [exe, ...pre] = await dvcCommand(cwd, log);
  return runProcess(exe, [...pre, ...args], cwd, log);
}

/**
 * Serialises every dvc invocation of a repository: DVC takes a repository lock,
 * so two concurrent commands would fail with "Unable to acquire lock".
 */
export class DvcRunner {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly root: string,
    private readonly log: vscode.OutputChannel,
  ) {}

  run(args: string[], token?: vscode.CancellationToken): Promise<RunResult> {
    const next = this.queue.then(async () => {
      const [exe, ...pre] = await dvcCommand(this.root, this.log);
      return runProcess(exe, [...pre, ...args], this.root, this.log, token);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async json<T>(args: string[]): Promise<T> {
    const { stdout } = await this.run(args);
    // Some DVC versions print warnings before the JSON document on stdout.
    const start = stdout.search(/[{[]/);
    return JSON.parse(start >= 0 ? stdout.slice(start) : stdout) as T;
  }
}

export function git(args: string[], cwd: string, log: vscode.OutputChannel): Promise<RunResult> {
  return runProcess('git', args, cwd, log);
}
