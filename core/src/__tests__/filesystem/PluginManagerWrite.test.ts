import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileSystem } from '../../filesystem/FileSystem.js';
import { PluginManager } from '../../filesystem/PluginManager.js';
import { PluginType } from '@ignite/plugin-types/types';

const meta = (id: string) => ({
  id,
  type: PluginType.COMPILER,
  name: `Plugin ${id}`,
  version: '1.0.0',
  baseImage: `ignite/installed_${id}:1.0.0`,
});

describe('PluginManager write path', () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-pm-'));
    // FileSystem is a singleton; reset instances and create new ones with test home.
    (FileSystem as unknown as { instance?: FileSystem }).instance = undefined;
    (PluginManager as unknown as { instance?: PluginManager }).instance =
      undefined;
    // Create instances with isolated test home
    FileSystem.getInstance(home);
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('adds, reads back, checks, and removes a plugin', async () => {
    const pm = PluginManager.getInstance();
    expect(await pm.hasPlugin('waffle')).toBe(false);

    await pm.addPlugin(meta('waffle'));
    expect(await pm.hasPlugin('waffle')).toBe(true);
    expect((await pm.getPlugin('waffle')).baseImage).toBe(
      'ignite/installed_waffle:1.0.0'
    );

    await pm.removePlugin('waffle');
    expect(await pm.hasPlugin('waffle')).toBe(false);
  });

  it('removePlugin on a missing id is a no-op (does not throw)', async () => {
    const pm = PluginManager.getInstance();
    await expect(pm.removePlugin('ghost')).resolves.toBeUndefined();
  });
});
