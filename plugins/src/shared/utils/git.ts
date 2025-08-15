import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PluginResponse } from "../types.js";

const execFileAsync = promisify(execFile);
const WORKSPACE_PATH = "/workspace";

export async function execGit(
  args: string[],
  cwd: string = WORKSPACE_PATH,
): Promise<PluginResponse<{ stdout: string; stderr: string }>> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd });
    return { success: true, data: { stdout, stderr } };
  } catch (error) {
    return {
      success: false,
      error: {
        code: "GIT_COMMAND_FAILED",
        message: `git ${args.join(" ")} failed`,
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      },
    };
  }
}

export async function isGitRepo(
  cwd: string = WORKSPACE_PATH,
): Promise<boolean> {
  const result = await execGit(["rev-parse", "--is-inside-work-tree"], cwd);
  return result.success;
}

export async function ensureGitRepo(
  cwd: string = WORKSPACE_PATH,
): Promise<PluginResponse<true>> {
  const ok = await isGitRepo(cwd);
  if (!ok) {
    return {
      success: false,
      error: {
        code: "NOT_GIT_REPO",
        message: `Not a git repository at ${cwd}`,
      },
    };
  }
  return { success: true, data: true } as const;
}

export async function hasTrackedChanges(
  cwd: string = WORKSPACE_PATH,
): Promise<PluginResponse<boolean>> {
  const status = await execGit(
    ["status", "--porcelain", "--untracked-files=no"],
    cwd,
  );
  if (!status.success) return status as any;
  const dirty = status.data.stdout.trim().length > 0;
  return { success: true, data: dirty } as const;
}

export async function ensureCleanRepo(
  cwd: string = WORKSPACE_PATH,
): Promise<PluginResponse<true>> {
  const dirty = await hasTrackedChanges(cwd);
  if (!dirty.success) return dirty as any;
  if (dirty.data) {
    return {
      success: false,
      error: {
        code: "DIRTY_REPO",
        message: "Repository has uncommitted changes",
      },
    };
  }
  return { success: true, data: true } as const;
}

export async function listAllRefs(
  cwd: string = WORKSPACE_PATH,
): Promise<PluginResponse<string[]>> {
  const res = await execGit(
    [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ],
    cwd,
  );
  if (!res.success) return res as any;
  const branches = res.data.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return { success: true, data: branches } as const;
}

export async function getCurrentBranch(
  cwd: string = WORKSPACE_PATH,
): Promise<PluginResponse<string | null>> {
  const res = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (!res.success) return res as any;
  const name = res.data.stdout.trim();
  return { success: true, data: name === "HEAD" ? null : name } as const;
}

export async function getCurrentCommit(
  cwd: string = WORKSPACE_PATH,
): Promise<PluginResponse<string>> {
  const res = await execGit(["rev-parse", "HEAD"], cwd);
  if (!res.success) return res as any;
  return { success: true, data: res.data.stdout.trim() } as const;
}

export async function fetchAll(
  cwd: string = WORKSPACE_PATH,
): Promise<PluginResponse<true>> {
  const res = await execGit(["fetch", "--all", "--prune"], cwd);
  if (!res.success) return res as any;
  return { success: true, data: true } as const;
}

export async function isUpToDateWithRemote(
  cwd: string = WORKSPACE_PATH,
): Promise<PluginResponse<boolean>> {
  const branch = await getCurrentBranch(cwd);
  if (!branch.success) return branch as any;
  if (branch.data === null) {
    // detached HEAD; can't compare to tracking branch—consider up to date
    return { success: true, data: true } as const;
  }
  const fetch = await fetchAll(cwd);
  if (!fetch.success) return fetch as any;
  // Compare local HEAD to upstream
  const res = await execGit(
    ["rev-list", "--left-only", "--count", "@{u}...HEAD"],
    cwd,
  );
  if (!res.success) return res as any;
  const aheadCount = parseInt(res.data.stdout.trim() || "0", 10);
  // If left-only count > 0, upstream has commits we don't have → not up to date
  return { success: true, data: aheadCount === 0 } as const;
}
