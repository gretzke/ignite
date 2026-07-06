import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  createTestDirectory,
  cleanupTestDirectory,
  resetFilesystemSingletons,
} from '../setup.js';
import { FileSystem } from '../../filesystem/FileSystem.js';
import { ProfileManager } from '../../filesystem/ProfileManager.js';
import { JobManager } from '../../jobs/JobManager.js';
import { RepoLifecycle } from '../../repos/RepoLifecycle.js';
import { factoryReset } from '../../system/factoryReset.js';

describe('factoryReset', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTestDirectory();
    resetFilesystemSingletons();
    RepoLifecycle.resetInstance();
    FileSystem.getInstance(testDir);
  });

  afterEach(async () => {
    await cleanupTestDirectory(testDir);
  });

  it('wipes the ignite home and re-bootstraps a fresh default profile', async () => {
    // Populate state: default profile + an extra profile + stray dirs/files
    const manager = await ProfileManager.getInstance();
    const extra = await manager.createProfile('scratch');
    const fileSystem = FileSystem.getInstance();
    await fs.mkdir(path.join(testDir, 'repos', 'default'), {
      recursive: true,
    });
    await fs.writeFile(path.join(testDir, 'repos', 'default', 'junk'), 'x');
    await fileSystem.writeJsonFile(path.join(testDir, 'jobs', 'j1.json'), {
      id: 'j1',
    });

    await factoryReset();

    // Old state gone
    const profiles = await fileSystem.listProfiles();
    expect(profiles).toEqual(['default']);
    expect(
      await fileSystem.fileExists(path.join(testDir, 'repos', 'default'))
    ).toBe(false);
    expect(
      await fileSystem.fileExists(path.join(testDir, 'jobs', 'j1.json'))
    ).toBe(false);
    expect(
      await fileSystem.fileExists(fileSystem.getProfilePath(extra.id))
    ).toBe(false);

    // Fresh bootstrap: default profile + global config recreated
    const freshManager = await ProfileManager.getInstance();
    expect(freshManager.getCurrentProfile()).toBe('default');
    const config = await freshManager.getCurrentProfileConfig();
    expect(config.name).toBe('Default');
    const globalConfig = await fileSystem.readGlobalConfig();
    expect(globalConfig.currentProfile).toBe('default');
  });

  it('cancels and forgets in-flight jobs so nothing re-persists post-wipe', async () => {
    const jobs = JobManager.getInstance();
    let aborted = false;
    const job = jobs.start('test.hang', {}, (ctx) => {
      return new Promise((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    });
    // Let the runner start (JobManager defers to a microtask)
    await new Promise((r) => setTimeout(r, 10));

    await factoryReset();

    expect(aborted).toBe(true);
    expect(jobs.get(job.id)).toBeUndefined();
    expect(jobs.list()).toEqual([]);
  });
});
