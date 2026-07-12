import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VerificationStore } from '../../verifications/VerificationStore.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }))
  );
});

async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-vstore-'));
  dirs.push(dir);
  const file = path.join(dir, 'profiles', 'p', 'verifications', 'tasks.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  return { store: new VerificationStore({ baseDir: dir }), file };
}

describe('VerificationStore quarantine', () => {
  it('quarantines a corrupt file to a .bad sidecar and starts empty', async () => {
    const { store, file } = await makeStore();
    await fs.writeFile(file, '{ not json');
    expect(await store.list('p')).toEqual([]);
    await expect(fs.access(`${file}.bad`)).resolves.toBeUndefined();
  });

  it('quarantines a wrong-schema file the same way', async () => {
    const { store, file } = await makeStore();
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 99, tasks: {} }));
    expect(await store.list('p')).toEqual([]);
    await expect(fs.access(`${file}.bad`)).resolves.toBeUndefined();
  });

  it('keeps writing normally after quarantine', async () => {
    const { store, file } = await makeStore();
    await fs.writeFile(file, 'garbage');
    await store.create('p', {
      chainId: 1,
      address: '0x0000000000000000000000000000000000000001',
      bundleHash: 'a'.repeat(64),
      encodedConstructorArgs: '0x',
      explorer: {
        entryId: 'e',
        url: 'https://scan.test',
        verifierPluginId: 'v',
        label: 'S',
      },
      origin: { kind: 'manual' },
    } as never);
    const tasks = await store.list('p');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('queued');
  });

  it('quarantines a file with a malformed task entry (tasks: [null])', async () => {
    const { store, file } = await makeStore();
    await fs.writeFile(
      file,
      JSON.stringify({ schemaVersion: 1, tasks: [null] })
    );
    expect(await store.list('p')).toEqual([]);
    await expect(fs.access(`${file}.bad`)).resolves.toBeUndefined();
  });

  it('normalizes bare/empty constructor tails from early D4 records on read', async () => {
    const { store, file } = await makeStore();
    const base = {
      chainId: 1,
      bundleHash: 'a'.repeat(64),
      explorer: { entryId: 'e', url: 'https://scan.test', verifierPluginId: 'v', label: 'S' },
      origin: { kind: 'manual' },
      status: 'failed',
      attempts: [],
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    };
    await fs.writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        tasks: [
          { ...base, id: 't1', address: '0x0000000000000000000000000000000000000001', encodedConstructorArgs: '' },
          { ...base, id: 't2', address: '0x0000000000000000000000000000000000000002', encodedConstructorArgs: 'deadbeef' },
        ],
      })
    );
    const tasks = await store.list('p');
    expect(tasks.map((t) => t.encodedConstructorArgs)).toEqual(['0x', '0xdeadbeef']);
  });
});
