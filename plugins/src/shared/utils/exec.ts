import { spawn } from "node:child_process";
import type { PluginResponse } from "../types.js";

const WORKSPACE_PATH = "/workspace";

// Matches Node's `child_process.execFile` default (1024 * 1024 bytes) since
// that was the implicit ceiling of the previous execFile-based
// implementation. Kept identical rather than raised, since callers that
// need more should opt in explicitly via `ExecOptions.maxBuffer`.
const DEFAULT_MAX_BUFFER = 1024 * 1024;

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  /**
   * When true (the default), each stdout/stderr chunk is written through to
   * this process's own stdout/stderr as it arrives, in addition to being
   * captured for the returned result. This is what makes tool output (e.g.
   * `forge build`, `hardhat compile`) show up live in job logs: the host
   * demuxes the plugin container's stdout/stderr stream and forwards it as
   * `log` job events as it arrives (see PluginExecutor.onOutput). The
   * result-framing protocol (`frameResult`, written last via a single
   * `console.log`) is designed to tolerate arbitrary extra stdout before it
   * — the host parser scans for the last complete sentinel block — so
   * passthrough is safe by default.
   *
   * Set to false for commands whose output must never be echoed (e.g. a
   * command whose stdout/stderr could contain secrets). No current call
   * site needs this, but the option exists for future callers.
   */
  passthrough?: boolean;
  /** Max combined bytes buffered per stream before the command is aborted. */
  maxBuffer?: number;
}

export async function execCommand(
  command: string,
  args: string[] = [],
  cwd: string = WORKSPACE_PATH,
  options: ExecOptions = {},
): Promise<PluginResponse<ExecResult>> {
  const passthrough = options.passthrough ?? true;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;

  try {
    const { stdout, stderr, exitCode } = await runSpawned(
      command,
      args,
      cwd,
      passthrough,
      maxBuffer,
    );
    return {
      success: true,
      data: {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode,
      },
    };
  } catch (error: any) {
    return {
      success: false,
      error: {
        code: "COMMAND_EXECUTION_FAILED",
        message: `${command} ${args.join(" ")} failed`,
        details: {
          error: error instanceof Error ? error.message : String(error),
          stdout: error.stdout?.trim() || "",
          stderr: error.stderr?.trim() || "",
          exitCode: error.exitCode ?? error.code ?? 1,
        },
      },
    };
  }
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Runs `command` via spawn, capturing stdout/stderr into buffers while also
// (optionally) forwarding each chunk live to this process's own
// stdout/stderr as it arrives. Rejects on non-zero exit, spawn error, or
// maxBuffer overflow, attaching whatever stdout/stderr/exitCode had been
// captured so far to the rejection (mirroring what execFile attaches to its
// error object) so callers can still surface partial output.
function runSpawned(
  command: string,
  args: string[],
  cwd: string,
  passthrough: boolean,
  maxBuffer: number,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PATH: process.env.PATH },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let settled = false;

    const fail = (error: Error & { code?: unknown }) => {
      if (settled) return;
      settled = true;
      (error as any).stdout = Buffer.concat(stdoutChunks).toString("utf8");
      (error as any).stderr = Buffer.concat(stderrChunks).toString("utf8");
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.kill();
      reject(error);
    };

    child.on("error", (err) => {
      fail(err);
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutLen += chunk.length;
      if (stdoutLen > maxBuffer) {
        fail(new Error(`stdout maxBuffer length exceeded for ${command}`));
        return;
      }
      stdoutChunks.push(chunk);
      if (passthrough) process.stdout.write(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderrLen += chunk.length;
      if (stderrLen > maxBuffer) {
        fail(new Error(`stderr maxBuffer length exceeded for ${command}`));
        return;
      }
      stderrChunks.push(chunk);
      if (passthrough) process.stderr.write(chunk);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const exitCode = code ?? 1;
      if (code !== 0) {
        settled = true;
        const error: any = new Error(
          signal
            ? `${command} terminated by signal ${signal}`
            : `${command} exited with code ${exitCode}`,
        );
        error.stdout = stdout;
        error.stderr = stderr;
        error.exitCode = exitCode;
        reject(error);
        return;
      }
      settled = true;
      resolve({ stdout, stderr, exitCode });
    });
  });
}

export async function execShell(
  command: string,
  cwd: string = WORKSPACE_PATH,
): Promise<PluginResponse<ExecResult>> {
  return execCommand("sh", ["-c", command], cwd);
}
