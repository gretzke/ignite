import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Docker from 'dockerode';
import { getLogger } from '../../utils/logger.js';
import type {
  PluginBuildBackend,
  PluginBuildResult,
  PluginInstallSource,
} from './types.js';
import { IsolatedBuilder } from './IsolatedBuilder.js';
import { finalizeBuiltImage } from './finalizeImage.js';

const CLONE_TIMEOUT_MS = 2 * 60 * 1000;

// Spec B backend: clones a git repo (hooks disabled — clone itself runs no repo
// code, but disable hooks defensively) and builds it inside the IsolatedBuilder,
// so untrusted build-time code (RUN steps, npm lifecycle scripts) can never
// touch the host. Produces the same { imageTag, metadata } as the local backend.
export class GitSourceBuildBackend implements PluginBuildBackend {
  private docker = new Docker();
  private builder = new IsolatedBuilder();

  async buildPluginImage(
    source: PluginInstallSource
  ): Promise<PluginBuildResult> {
    if (source.kind !== 'git') {
      throw new Error(
        `GitSourceBuildBackend cannot handle source kind '${source.kind}'`
      );
    }
    const cloneDir = await mkdtemp(path.join(tmpdir(), 'ignite-git-'));
    try {
      await this.clone(source.url, source.ref, cloneDir);
      // Dockerfile is expected at the repo root (the third-party plugin convention).
      const tempTag = await this.builder.buildToTempTag(cloneDir, 'Dockerfile');
      return finalizeBuiltImage(this.docker, tempTag);
    } finally {
      await rm(cloneDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Shallow clone with hooks disabled. -c core.hooksPath=/dev/null prevents any
  // repo-supplied hook from running; --depth 1 keeps it fast. If a ref is given,
  // clone then checkout it.
  private clone(url: string, ref: string | undefined, dir: string): Promise<void> {
    const args = [
      '-c', 'core.hooksPath=/dev/null',
      'clone', '--depth', '1', '--no-tags',
    ];
    if (ref) args.push('--branch', ref);
    args.push('--', url, dir);
    getLogger().info(`⬇️  Cloning plugin source from ${url}${ref ? `@${ref}` : ''}`);
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`git clone timed out after ${CLONE_TIMEOUT_MS}ms`));
      }, CLONE_TIMEOUT_MS);
      child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`git clone failed (exit ${code}): ${stderr.trim()}`));
      });
    });
  }
}
