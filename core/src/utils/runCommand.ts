// Promise wrapper around child_process.spawn for the common
// run-and-collect-output case. Non-zero exits RESOLVE (callers decide what a
// failure means); spawn errors and timeouts reject.
import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable, Writable } from 'stream';

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function runCommand(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    // Kills the child on abort (job cancellation). Rejects with the
    // signal's reason so callers can distinguish cancel from failure.
    signal?: AbortSignal;
    // Written to the child's stdin and closed immediately after. When
    // omitted, stdin stays 'ignore' — identical to prior behavior — so
    // existing call sites (git subprocess invocations) are unaffected.
    input?: string;
  } = {}
): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(opts.signal.reason ?? new Error(`${cmd} aborted before start`));
      return;
    }
    // spawn's stdio-tuple overloads are keyed on exact literal combinations,
    // so a computed (non-literal) first slot falls through to the untyped
    // SpawnOptions overload (nullable streams). Branch instead, so each call
    // keeps its precise, non-null stdout/stderr typing.
    const child: ChildProcessByStdio<Writable | null, Readable, Readable> =
      opts.input !== undefined
        ? spawn(cmd, args, {
            cwd: opts.cwd,
            env: opts.env,
            stdio: ['pipe', 'pipe', 'pipe'],
          })
        : spawn(cmd, args, {
            cwd: opts.cwd,
            env: opts.env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

    if (opts.input !== undefined) {
      // A fast-exiting child can close its stdin before we finish writing
      // (EPIPE); swallow that instead of letting it crash the process.
      child.stdin?.on('error', () => {});
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
    let stdout = '';
    let stderr = '';
    let settled = false;

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.kill('SIGKILL');
      reject(
        opts.signal?.reason ?? new Error(`${cmd} ${args.join(' ')} aborted`)
      );
    };
    const cleanupAbort = (): void =>
      opts.signal?.removeEventListener('abort', onAbort);

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          settled = true;
          cleanupAbort();
          child.kill('SIGKILL');
          reject(
            new Error(
              `${cmd} ${args.join(' ')} timed out after ${opts.timeoutMs}ms`
            )
          );
        }, opts.timeoutMs)
      : undefined;

    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      cleanupAbort();
      if (!settled) reject(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      cleanupAbort();
      if (!settled) resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}
