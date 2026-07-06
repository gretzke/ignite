// Host-side repository operations. Repositories are host data managed here —
// git runs directly on the host (hooks disabled, protocol allowlisted); repo
// content is never require()'d or eval'd. LOCAL repos: the host path IS the
// workspace. CLONED repos: workspace = <igniteHome>/repos/<profileId>/<dir>,
// a disposable clone with force-reset semantics (git is the source of truth,
// not user edits).
import path from 'node:path';
import fs from 'node:fs/promises';
import { URL } from 'node:url';
import { parseGitHubUrl, normalizeRepoUrl } from '@ignite/plugin-types';
import type { RepoInfoResult } from '@ignite/api';
import { FileSystem } from '../filesystem/FileSystem.js';
import { ProfileManager } from '../filesystem/ProfileManager.js';
import { hashWorkspacePath } from '../utils/startup.js';
import { runCommand, type RunCommandResult } from '../utils/runCommand.js';
import { getLogger } from '../utils/logger.js';

export enum RepoKind {
  LOCAL = 'local',
  CLONED = 'cloned',
}

// Ported from the now-deleted RepoContainerUtils.deriveRepoKind (Phase 3
// Task 4), with RepoContainerKind renamed to RepoKind.
export function deriveRepoKind(pathOrUrl: string): RepoKind {
  // Windows paths like C:\...
  if (/^[A-Za-z]:\\/.test(pathOrUrl)) return RepoKind.LOCAL;
  // Unix-like absolute or ~
  if (pathOrUrl.startsWith('/') || pathOrUrl.startsWith('~')) {
    return RepoKind.LOCAL;
  }
  // SSH-like git@host:owner/repo(.git)?
  if (/^git@[^:]+:.+/.test(pathOrUrl)) return RepoKind.CLONED;
  try {
    const u = new URL(pathOrUrl);
    if (u.protocol === 'file:') return RepoKind.LOCAL;
    if (['http:', 'https:', 'ssh:', 'git:'].includes(u.protocol)) {
      return RepoKind.CLONED;
    }
  } catch {
    // Not a URL
  }
  // Fallback: if contains :// assume cloned, else local
  return pathOrUrl.includes('://') ? RepoKind.CLONED : RepoKind.LOCAL;
}

export interface RepoServiceDeps {
  fileSystem?: FileSystem;
  profiles?: ProfileManager;
  run?: typeof runCommand;
}

// Mirrors the old PluginResponse contract so handlers built on top of this
// service stay thin (map straight to IApiResponse/IApiError).
export type RepoResult<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string } };

interface GitOutput {
  stdout: string;
  stderr: string;
}

// Host git safety rails (Global Constraints): hooks disabled so a malicious
// repo can't run code via post-checkout/post-merge etc; protocol allowlist so
// a host gitconfig with protocol.allow=always can't re-enable ext::/fd::
// transports (arbitrary command execution / fd inheritance).
const HOOKS_OFF = ['-c', 'core.hooksPath=/dev/null'];
const GIT_ALLOW_PROTOCOL = 'https:git:ssh:file';

// Timeouts per the Shared design: clone is slow (network + full history of
// the default branch), fetch/pull touch the network but are bounded, local
// ops never leave disk.
const TIMEOUT_CLONE_MS = 10 * 60 * 1000;
const TIMEOUT_FETCH_MS = 2 * 60 * 1000;
const TIMEOUT_LOCAL_MS = 30 * 1000;

// Schemes git is allowed to clone. Anything else (notably ext:: and fd::,
// which can execute an arbitrary host command / inherit an arbitrary fd) is
// rejected before any git invocation. scp-like `git@host:path` is the fourth
// accepted form alongside the three URL schemes plus file://.
export function isAllowedCloneUrl(url: string): boolean {
  return (
    /^https:\/\//i.test(url) ||
    /^git:\/\//i.test(url) ||
    /^ssh:\/\//i.test(url) ||
    /^file:\/\//i.test(url) ||
    /^git@[^:]+:.+/.test(url)
  );
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Host-side replacement for the containerized repo-manager plugins. Every op
// mirrors the exact behavioral contract of plugins/src/repo-manager/{local,
// cloned}-repo (dirty guards, force-reset, origin/-prefix checkout, shallow
// clone + remote-heads fetch, upToDate via left-only rev-list, detached HEAD
// -> branch null). Credentials: none — the host's ambient environment
// (ssh-agent, credential helpers, netrc) is the whole story; this class never
// touches or stores any secret.
export class RepoService {
  private static instance: RepoService;

  private readonly fileSystem: FileSystem;
  private readonly injectedProfiles?: ProfileManager;
  private readonly run: typeof runCommand;

  constructor(deps?: RepoServiceDeps) {
    this.fileSystem = deps?.fileSystem ?? FileSystem.getInstance();
    this.injectedProfiles = deps?.profiles;
    this.run = deps?.run ?? runCommand;
  }

  static getInstance(): RepoService {
    if (!RepoService.instance) {
      RepoService.instance = new RepoService();
    }
    return RepoService.instance;
  }

  // === Identity -> host workspace dir ===

  // LOCAL: pathOrUrl itself is the workspace. CLONED: a deterministic,
  // per-profile directory under <igniteHome>/repos/<profileId>, so the same
  // URL clones to the same place across restarts and different profiles
  // never share a clone.
  async resolveWorkspacePath(pathOrUrl: string): Promise<string> {
    const kind = deriveRepoKind(pathOrUrl);
    if (kind === RepoKind.LOCAL) {
      return pathOrUrl;
    }
    const profileId = await this.getProfileId();
    const reposPath = this.fileSystem.getReposPath(profileId);
    return path.join(reposPath, this.clonedDirName(pathOrUrl));
  }

  private async getProfileId(): Promise<string> {
    const profiles = this.injectedProfiles ?? (await ProfileManager.getInstance());
    return profiles.getCurrentProfile();
  }

  // Sanitized <owner>-<repo>-<hash> directory name. normalizeRepoUrl folds
  // scp-like and HTTPS forms of the same GitHub/GitLab repo to one canonical
  // string first, so cloning the "same" repo via a different URL scheme
  // reuses the same workspace instead of creating a duplicate clone.
  private clonedDirName(pathOrUrl: string): string {
    const slug = (s: string): string =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'repo';

    let owner = 'unknown';
    let repo = 'repo';
    const gh = parseGitHubUrl(pathOrUrl);
    if (gh) {
      owner = slug(gh.owner);
      repo = slug(gh.name);
    } else {
      const parts = this.extractPathSegments(pathOrUrl);
      if (parts.length >= 2) {
        owner = slug(parts[parts.length - 2]);
        repo = slug(parts[parts.length - 1]);
      } else if (parts.length === 1) {
        repo = slug(parts[0]);
      }
    }
    const hash = hashWorkspacePath(normalizeRepoUrl(pathOrUrl));
    return `${owner}-${repo}-${hash}`;
  }

  // Best-effort owner/repo path segments for non-GitHub URLs (self-hosted
  // GitLab/Gitea/etc, or scp-like git@host:owner/repo forms that don't parse
  // as a WHATWG URL).
  private extractPathSegments(pathOrUrl: string): string[] {
    try {
      const u = new URL(pathOrUrl);
      return u.pathname
        .replace(/\.git$/, '')
        .split('/')
        .filter(Boolean);
    } catch {
      const afterColon = pathOrUrl.includes(':')
        ? (pathOrUrl.split(':').pop() as string)
        : pathOrUrl;
      return afterColon
        .replace(/\.git$/, '')
        .split('/')
        .filter(Boolean);
    }
  }

  // === Ops ===

  // LOCAL: ensure the host path is a git repo. CLONED: clone if the dir is
  // missing/not yet a repo, then fetch remote heads; idempotent if already
  // cloned (matches the old plugin: a second init is a cheap no-op, it does
  // NOT re-fetch).
  async init(pathOrUrl: string): Promise<RepoResult<null>> {
    try {
      const kind = deriveRepoKind(pathOrUrl);
      const workspacePath = await this.resolveWorkspacePath(pathOrUrl);

      if (kind === RepoKind.LOCAL) {
        const ensured = await this.ensureGitRepo(workspacePath);
        if (!ensured.success) return ensured;
        return { success: true, data: null };
      }

      // CLONED: validate the URL scheme before any git invocation.
      if (!isAllowedCloneUrl(pathOrUrl)) {
        return {
          success: false,
          error: {
            code: 'CLONE_FAILED',
            message:
              `Refusing to clone repository: unsupported URL scheme in '${pathOrUrl}'. ` +
              'Only https://, git://, ssh://, file://, and git@host:path are allowed.',
          },
        };
      }

      if (await this.isGitRepo(workspacePath)) {
        // Already cloned — idempotent no-op, matches the old plugin.
        return { success: true, data: null };
      }

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: workspacePath is derived from FileSystem.getReposPath(profileId), not user input
      await fs.mkdir(path.dirname(workspacePath), { recursive: true });

      const clone = await this.runGit(
        path.dirname(workspacePath),
        [
          'clone',
          '--depth',
          '1',
          '--recurse-submodules',
          '--shallow-submodules',
          pathOrUrl,
          workspacePath,
        ],
        TIMEOUT_CLONE_MS
      );
      if (!clone.success) {
        await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => {});
        return {
          success: false,
          error: {
            code: 'CLONE_FAILED',
            message: `Failed to clone repository: ${clone.error.message}`,
          },
        };
      }

      // Fetch the full set of remote heads so non-default branches show up in
      // getBranches. This is best-effort and NOT gated: the reference plugin
      // (cloned-repo/index.ts) fires this fetch and ignores its result, and
      // gating init on it would be actively harmful — a transient network
      // blip after a successful clone would return CLONE_FAILED, yet a retry
      // short-circuits on the already-present clone (isGitRepo === true) and
      // reports success WITHOUT ever re-fetching, permanently stranding the
      // clone missing its non-default branches. Log and move on; a later
      // init/getBranches/checkout re-runs `fetch --all` and recovers.
      const fetchHeads = await this.runGit(
        workspacePath,
        ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*'],
        TIMEOUT_FETCH_MS
      );
      if (!fetchHeads.success) {
        getLogger().warn(
          `Cloned ${pathOrUrl} but failed to fetch all remote heads (non-default branches may be missing until the next fetch): ${fetchHeads.error.message}`
        );
      }

      return { success: true, data: null };
    } catch (error) {
      return { success: false, error: { code: 'INIT_ERROR', message: errMsg(error) } };
    }
  }

  async getBranches(pathOrUrl: string): Promise<RepoResult<{ branches: string[] }>> {
    try {
      const cwd = await this.resolveWorkspacePath(pathOrUrl);
      const ensured = await this.ensureGitRepo(cwd);
      if (!ensured.success) return ensured;
      const refs = await this.listAllRefs(cwd);
      if (!refs.success) return refs;
      return { success: true, data: { branches: refs.data } };
    } catch (error) {
      return { success: false, error: { code: 'GET_BRANCHES_ERROR', message: errMsg(error) } };
    }
  }

  async checkoutBranch(pathOrUrl: string, branch: string): Promise<RepoResult<null>> {
    try {
      const kind = deriveRepoKind(pathOrUrl);
      const cwd = await this.resolveWorkspacePath(pathOrUrl);

      if (kind === RepoKind.LOCAL) {
        const clean = await this.ensureCleanRepo(cwd);
        if (!clean.success) return clean;
      } else {
        const ensured = await this.ensureGitRepo(cwd);
        if (!ensured.success) return ensured;
      }

      const fetchRes = await this.runGit(cwd, ['fetch', '--all', '--prune'], TIMEOUT_FETCH_MS);
      if (!fetchRes.success) return fetchRes;

      if (kind === RepoKind.CLONED) {
        const reset = await this.hardReset(cwd);
        if (!reset.success) return reset;
      }

      const co = await this.doCheckoutBranch(cwd, branch);
      if (!co.success) return co;

      return { success: true, data: null };
    } catch (error) {
      return {
        success: false,
        error: { code: 'CHECKOUT_BRANCH_ERROR', message: errMsg(error) },
      };
    }
  }

  // Shared origin/-prefix handling: checking out "origin/foo" creates (or
  // reuses) a local tracking branch "foo" rather than leaving HEAD detached.
  private async doCheckoutBranch(cwd: string, branch: string): Promise<RepoResult<null>> {
    if (branch.startsWith('origin/')) {
      const localBranchName = branch.replace('origin/', '');
      const branchExists = await this.runGit(
        cwd,
        ['show-ref', '--verify', '--quiet', `refs/heads/${localBranchName}`],
        TIMEOUT_LOCAL_MS
      );
      if (branchExists.success) {
        const co = await this.runGit(cwd, ['checkout', localBranchName], TIMEOUT_LOCAL_MS);
        if (!co.success) return co;
      } else {
        const co = await this.runGit(
          cwd,
          ['checkout', '-b', localBranchName, branch],
          TIMEOUT_LOCAL_MS
        );
        if (!co.success) return co;
      }
    } else {
      const co = await this.runGit(cwd, ['checkout', branch], TIMEOUT_LOCAL_MS);
      if (!co.success) return co;
    }
    return { success: true, data: null };
  }

  async checkoutCommit(pathOrUrl: string, commit: string): Promise<RepoResult<null>> {
    try {
      const kind = deriveRepoKind(pathOrUrl);
      const cwd = await this.resolveWorkspacePath(pathOrUrl);

      if (kind === RepoKind.LOCAL) {
        const clean = await this.ensureCleanRepo(cwd);
        if (!clean.success) return clean;
      } else {
        const ensured = await this.ensureGitRepo(cwd);
        if (!ensured.success) return ensured;
      }

      const fetchRes = await this.runGit(cwd, ['fetch', '--all', '--prune'], TIMEOUT_FETCH_MS);
      if (!fetchRes.success) return fetchRes;

      if (kind === RepoKind.CLONED) {
        const reset = await this.hardReset(cwd);
        if (!reset.success) return reset;
      }

      const co = await this.runGit(cwd, ['checkout', '--detach', commit], TIMEOUT_LOCAL_MS);
      if (!co.success) return co;

      return { success: true, data: null };
    } catch (error) {
      return {
        success: false,
        error: { code: 'CHECKOUT_COMMIT_ERROR', message: errMsg(error) },
      };
    }
  }

  async pullChanges(pathOrUrl: string): Promise<RepoResult<null>> {
    try {
      const kind = deriveRepoKind(pathOrUrl);
      const cwd = await this.resolveWorkspacePath(pathOrUrl);

      if (kind === RepoKind.LOCAL) {
        const clean = await this.ensureCleanRepo(cwd);
        if (!clean.success) return clean;
      } else {
        const ensured = await this.ensureGitRepo(cwd);
        if (!ensured.success) return ensured;
        // Cloned repos are managed clones with no user work to preserve, but
        // operations like compilation leave untracked byproducts behind
        // (e.g. foundry.lock) that make `git pull` abort when the incoming
        // commits touch the same paths. Force a pristine tree before pulling.
        const pristine = await this.makePristine(cwd);
        if (!pristine.success) return pristine;
      }

      const pull = await this.runGit(cwd, ['pull', '--ff-only'], TIMEOUT_FETCH_MS);
      if (!pull.success) return pull;

      return { success: true, data: null };
    } catch (error) {
      return { success: false, error: { code: 'PULL_ERROR', message: errMsg(error) } };
    }
  }

  // Destructive by design (frontend confirms before calling): discard
  // uncommitted changes and remove untracked files. Identical for both kinds.
  async reset(pathOrUrl: string): Promise<RepoResult<null>> {
    try {
      const cwd = await this.resolveWorkspacePath(pathOrUrl);
      const ensured = await this.ensureGitRepo(cwd);
      if (!ensured.success) return ensured;
      return await this.makePristine(cwd);
    } catch (error) {
      return { success: false, error: { code: 'RESET_ERROR', message: errMsg(error) } };
    }
  }

  async getRepoInfo(pathOrUrl: string): Promise<RepoResult<RepoInfoResult>> {
    try {
      const kind = deriveRepoKind(pathOrUrl);
      const cwd = await this.resolveWorkspacePath(pathOrUrl);

      const ensured = await this.ensureGitRepo(cwd);
      if (!ensured.success) return ensured;

      const branch = await this.getCurrentBranch(cwd);
      if (!branch.success) return branch;
      const commit = await this.getCurrentCommit(cwd);
      if (!commit.success) return commit;

      // Cloned repos are never dirty — every mutating op force-resets them.
      let dirty = false;
      if (kind === RepoKind.LOCAL) {
        const status = await this.hasTrackedChanges(cwd);
        if (!status.success) return status;
        dirty = status.data;
      }

      const upToDate = await this.isUpToDateWithRemote(cwd);
      if (!upToDate.success) return upToDate;

      return {
        success: true,
        data: {
          branch: branch.data,
          commit: commit.data,
          dirty,
          upToDate: upToDate.data,
        },
      };
    } catch (error) {
      return { success: false, error: { code: 'INFO_ERROR', message: errMsg(error) } };
    }
  }

  async getFile(pathOrUrl: string, filePath: string): Promise<RepoResult<{ content: string }>> {
    try {
      const validated = this.validateFilePath(filePath);
      if (!validated.success) return validated;

      const cwd = await this.resolveWorkspacePath(pathOrUrl);
      // path.join (not path.resolve) — an absolute-looking filePath must not
      // be able to override cwd the way path.resolve's right-to-left
      // semantics would (path.resolve(cwd, '/etc/passwd') === '/etc/passwd').
      const target = path.join(cwd, filePath);
      const resolvedRoot = path.resolve(cwd);
      const resolvedTarget = path.resolve(target);
      // Lexical containment: even though validateFilePath already rejects any
      // segment that could escape the root, re-derive containment from the
      // resolved absolute path before touching disk. Fast reject that runs
      // before any filesystem access.
      if (
        resolvedTarget !== resolvedRoot &&
        !resolvedTarget.startsWith(resolvedRoot + path.sep)
      ) {
        return {
          success: false,
          error: { code: 'INVALID_PATH', message: 'File path escapes repository root' },
        };
      }

      // Symlink-aware containment. Lexical checks and fs.stat/readFile follow
      // symlinks at the OS level, so a committed symlink (leaf OR an
      // intermediate path component) pointing outside the workspace would
      // otherwise leak arbitrary host files (~/.ssh/id_rsa, /etc/passwd, …).
      // For CLONED repos the working tree is fully attacker-controlled (any
      // public repo can commit such a symlink), and on the host this is the
      // ONLY containment jail — the old container jail is gone. Resolve BOTH
      // the root and the target to their real paths (the root too: on macOS
      // /tmp is itself a symlink to /private/tmp) and require the real target
      // to still live inside the real root. In-tree symlinks that resolve
      // back inside the workspace are allowed; anything escaping is refused
      // with SUSPICIOUS_PATH_PATTERN (an explicit containment refusal, NOT
      // FILE_NOT_FOUND — the file may well exist, we're declining to read it).
      let realRoot: string;
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: resolvedRoot is FileSystem.getReposPath-derived or the LOCAL repo path
        realRoot = await fs.realpath(resolvedRoot);
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') {
          return {
            success: false,
            error: { code: 'FILE_NOT_FOUND', message: `File not found: ${filePath}` },
          };
        }
        throw error;
      }
      let realTarget: string;
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: containment is enforced against realRoot immediately below, before any read
        realTarget = await fs.realpath(resolvedTarget);
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') {
          return {
            success: false,
            error: { code: 'FILE_NOT_FOUND', message: `File not found: ${filePath}` },
          };
        }
        throw error;
      }
      if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
        return {
          success: false,
          error: {
            code: 'SUSPICIOUS_PATH_PATTERN',
            message: 'File path resolves outside the repository (symlink escape)',
          },
        };
      }

      let stats;
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: realTarget containment is checked above
        stats = await fs.stat(realTarget);
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') {
          return {
            success: false,
            error: { code: 'FILE_NOT_FOUND', message: `File not found: ${filePath}` },
          };
        }
        throw error;
      }
      if (!stats.isFile()) {
        return {
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: `Path is not a file: ${filePath}` },
        };
      }

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: realTarget containment is checked above
      const content = await fs.readFile(realTarget, 'utf8');
      return { success: true, data: { content } };
    } catch (error) {
      return { success: false, error: { code: 'FILE_READ_ERROR', message: errMsg(error) } };
    }
  }

  // Ported from plugins/src/shared/base/repo-manager/index.ts (validateFilePath,
  // lines 236-271) verbatim in behavior: empty/`..`/dot-leading segments are
  // INVALID_PATH; a remaining ".."/"./" substring after the segment scan
  // (e.g. a single segment literally named "a..b") is SUSPICIOUS_PATH_PATTERN.
  private validateFilePath(filePath: string): RepoResult<true> {
    const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const pathSegments = normalizedPath.split('/');

    for (const segment of pathSegments) {
      if (segment === '' || segment === '..' || segment.startsWith('.')) {
        return {
          success: false,
          error: {
            code: 'INVALID_PATH',
            message: `File path contains invalid segments: ${segment}`,
          },
        };
      }
    }

    if (normalizedPath.includes('..') || normalizedPath.includes('./')) {
      return {
        success: false,
        error: {
          code: 'SUSPICIOUS_PATH_PATTERN',
          message: 'File path contains suspicious patterns',
        },
      };
    }

    return { success: true, data: true };
  }

  // rm -rf the cloned workspace dir; LOCAL is a no-op (the host path is the
  // user's own repo, never ours to delete). Best-effort: mirrors the old
  // removeRepoContainers cleanup, which never blocks repo removal.
  async removeClone(pathOrUrl: string): Promise<void> {
    const kind = deriveRepoKind(pathOrUrl);
    if (kind === RepoKind.LOCAL) return;
    try {
      const workspacePath = await this.resolveWorkspacePath(pathOrUrl);
      await fs.rm(workspacePath, { recursive: true, force: true });
    } catch {
      // Best-effort; failure to clean up disk must not block the caller.
    }
  }

  // === Git primitives (ported from plugins/src/shared/utils/git.ts,
  // parameterized on cwd instead of a fixed /workspace) ===

  private async isGitRepo(cwd: string): Promise<boolean> {
    const r = await this.runGit(cwd, ['rev-parse', '--is-inside-work-tree'], TIMEOUT_LOCAL_MS);
    return r.success;
  }

  private async ensureGitRepo(cwd: string): Promise<RepoResult<true>> {
    if (!(await this.isGitRepo(cwd))) {
      return {
        success: false,
        error: { code: 'NOT_GIT_REPO', message: `Not a git repository at ${cwd}` },
      };
    }
    return { success: true, data: true };
  }

  private async hasTrackedChanges(cwd: string): Promise<RepoResult<boolean>> {
    const res = await this.runGit(cwd, ['status', '--porcelain'], TIMEOUT_LOCAL_MS);
    if (!res.success) return res;
    return { success: true, data: res.data.stdout.trim().length > 0 };
  }

  private async ensureCleanRepo(cwd: string): Promise<RepoResult<true>> {
    const dirty = await this.hasTrackedChanges(cwd);
    if (!dirty.success) return dirty;
    if (dirty.data) {
      return {
        success: false,
        error: { code: 'DIRTY_REPO', message: 'Repository has uncommitted changes' },
      };
    }
    return { success: true, data: true };
  }

  private async listAllRefs(cwd: string): Promise<RepoResult<string[]>> {
    const res = await this.runGit(
      cwd,
      [
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/heads',
        'refs/remotes',
        'refs/tags',
      ],
      TIMEOUT_LOCAL_MS
    );
    if (!res.success) return res;
    const branches = res.data.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    return { success: true, data: branches };
  }

  private async getCurrentBranch(cwd: string): Promise<RepoResult<string | null>> {
    const res = await this.runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], TIMEOUT_LOCAL_MS);
    if (!res.success) return res;
    const name = res.data.stdout.trim();
    return { success: true, data: name === 'HEAD' ? null : name };
  }

  private async getCurrentCommit(cwd: string): Promise<RepoResult<string>> {
    const res = await this.runGit(cwd, ['rev-parse', 'HEAD'], TIMEOUT_LOCAL_MS);
    if (!res.success) return res;
    return { success: true, data: res.data.stdout.trim() };
  }

  private async isUpToDateWithRemote(cwd: string): Promise<RepoResult<boolean>> {
    const branch = await this.getCurrentBranch(cwd);
    if (!branch.success) return branch;
    if (branch.data === null) {
      // Detached HEAD; nothing to compare to a tracking branch — up to date.
      return { success: true, data: true };
    }

    const upstreamCheck = await this.runGit(
      cwd,
      ['rev-parse', '--abbrev-ref', `${branch.data}@{u}`],
      TIMEOUT_LOCAL_MS
    );
    if (!upstreamCheck.success) {
      // No upstream configured (local-only branch) — nothing to compare, up
      // to date.
      return { success: true, data: true };
    }

    const fetch = await this.runGit(cwd, ['fetch', '--all', '--prune'], TIMEOUT_FETCH_MS);
    if (!fetch.success) return fetch;

    const res = await this.runGit(
      cwd,
      ['rev-list', '--left-only', '--count', '@{u}...HEAD'],
      TIMEOUT_LOCAL_MS
    );
    if (!res.success) return res;
    const aheadCount = parseInt(res.data.stdout.trim() || '0', 10);
    return { success: true, data: aheadCount === 0 };
  }

  // `reset --hard` only — used by checkout flows to force a clean cloned
  // workspace before switching ref (matches the old cloned-repo plugin,
  // which does NOT also `clean -fd` here).
  private async hardReset(cwd: string): Promise<RepoResult<null>> {
    const res = await this.runGit(cwd, ['reset', '--hard'], TIMEOUT_LOCAL_MS);
    if (!res.success) return res;
    return { success: true, data: null };
  }

  // `reset --hard` + `clean -fd` — a fully pristine working tree, used by
  // `reset()` (both kinds) and cloned `pullChanges` (reset --hard alone
  // leaves untracked files behind, which can make a pull abort).
  private async makePristine(cwd: string): Promise<RepoResult<null>> {
    const res = await this.hardReset(cwd);
    if (!res.success) return res;
    const clean = await this.runGit(cwd, ['clean', '-fd'], TIMEOUT_LOCAL_MS);
    if (!clean.success) return clean;
    return { success: true, data: null };
  }

  // Every git invocation goes through here so the safety rails (hooks
  // disabled, protocol allowlist) are structurally impossible to bypass.
  // Mirrors the old plugin-side execGit contract: any failure — spawn error,
  // timeout, or a non-zero exit — comes back as GIT_COMMAND_FAILED rather
  // than throwing, so callers never need a try/catch around a git call.
  private async runGit(
    cwd: string,
    args: string[],
    timeoutMs: number
  ): Promise<RepoResult<GitOutput>> {
    let result: RunCommandResult;
    try {
      result = await this.run('git', [...HOOKS_OFF, ...args], {
        cwd,
        env: { ...process.env, GIT_ALLOW_PROTOCOL },
        timeoutMs,
      });
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'GIT_COMMAND_FAILED',
          message: `git ${args.join(' ')} failed: ${errMsg(error)}`,
        },
      };
    }
    if (result.code !== 0) {
      return {
        success: false,
        error: {
          code: 'GIT_COMMAND_FAILED',
          message: `git ${args.join(' ')} failed (exit ${result.code}): ${result.stderr.trim()}`,
        },
      };
    }
    return { success: true, data: { stdout: result.stdout, stderr: result.stderr } };
  }
}
