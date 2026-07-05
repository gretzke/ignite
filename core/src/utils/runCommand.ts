// Promise wrapper around child_process.spawn for the common
// run-and-collect-output case. Non-zero exits RESOLVE (callers decide what a
// failure means); spawn errors and timeouts reject.
import { spawn } from 'child_process';

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          settled = true;
          child.kill('SIGKILL');
          reject(
            new Error(`${cmd} ${args.join(' ')} timed out after ${opts.timeoutMs}ms`)
          );
        }, opts.timeoutMs)
      : undefined;

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      if (!settled) reject(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (!settled) resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}
