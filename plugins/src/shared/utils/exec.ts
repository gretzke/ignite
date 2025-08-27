import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PluginResponse } from "../types.js";

const execFileAsync = promisify(execFile);
const WORKSPACE_PATH = "/workspace";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function execCommand(
  command: string,
  args: string[] = [],
  cwd: string = WORKSPACE_PATH,
): Promise<PluginResponse<ExecResult>> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      env: { ...process.env, PATH: process.env.PATH },
    });
    return {
      success: true,
      data: {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: 0,
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
          exitCode: error.code || 1,
        },
      },
    };
  }
}

export async function execShell(
  command: string,
  cwd: string = WORKSPACE_PATH,
): Promise<PluginResponse<ExecResult>> {
  return execCommand("sh", ["-c", command], cwd);
}
