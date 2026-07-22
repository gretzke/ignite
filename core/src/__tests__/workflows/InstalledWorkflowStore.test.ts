import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { InstalledWorkflowRecord } from '@ignite/api';
import { FileSystem } from '../../filesystem/FileSystem.js';
import { InstalledWorkflowStore } from '../../workflows/InstalledWorkflowStore.js';

const dirs: string[] = [];
const profileId = 'p1';
const keyA = { repoPathOrUrl: '/repos/a', name: 'workflow-a' };
const keyB = { repoPathOrUrl: '/repos/b', name: 'workflow-b' };

async function temp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function store(
  home: string
): Promise<{ fileSystem: FileSystem; store: InstalledWorkflowStore }> {
  FileSystem.resetInstance();
  const fileSystem = FileSystem.getInstance(home);
  return { fileSystem, store: new InstalledWorkflowStore(fileSystem) };
}

function installed(
  docHash = 'a'.repeat(64)
): NonNullable<InstalledWorkflowRecord['installed']> {
  return {
    docHash,
    at: '2026-07-22T00:00:00.000Z',
    sources: [
      {
        kind: 'repo',
        id: 'source-a',
        pin: {
          url: 'https://example.test/a.git',
          commit: 'a'.repeat(40),
          ref: 'v1.0.0',
          refKind: 'tag',
        },
        frameworkId: 'foundry',
        sourcePath: 'src/A.sol',
        contractName: 'A',
        artifactPath: 'out/A.sol/A.json',
      },
    ],
    plugins: [{ id: 'foundry', version: '1.0.0' }],
    stepsHash: 'b'.repeat(64),
    hooksHash: 'c'.repeat(64),
  };
}

function attempt(
  docHash = 'd'.repeat(64)
): NonNullable<InstalledWorkflowRecord['lastAttempt']> {
  return {
    docHash,
    at: '2026-07-22T01:00:00.000Z',
    status: 'failed',
    error: 'artifact missing',
    pins: [{ url: 'https://example.test/a.git', commit: 'a'.repeat(40) }],
  };
}

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe('InstalledWorkflowStore', () => {
  it('serializes concurrent read-modify-write operations across store instances', async () => {
    const home = await temp('ignite-installed-workflows-mutex-');
    const first = await store(home);
    const second = new InstalledWorkflowStore(first.fileSystem);

    await Promise.all([
      first.store.writeInstalled(profileId, keyA, installed()),
      second.writeInstalled(profileId, keyB, installed('e'.repeat(64))),
    ]);

    expect((await first.store.read(profileId)).records).toEqual(
      expect.arrayContaining([
        expect.objectContaining(keyA),
        expect.objectContaining(keyB),
      ])
    );
  });

  it('quarantines a garbage registry file and reports degraded state', async () => {
    const home = await temp('ignite-installed-workflows-garbage-');
    const { fileSystem, store: workflows } = await store(home);
    const registryPath = fileSystem.getProfileInstalledWorkflowsPath(profileId);
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, '{not json', 'utf8');

    await expect(workflows.read(profileId)).resolves.toEqual({
      records: [],
      degraded: true,
    });
    await expect(fs.access(registryPath)).rejects.toThrow();
    expect(
      (await fs.readdir(path.dirname(registryPath))).some((entry) =>
        entry.startsWith('installed.json.corrupt-')
      )
    ).toBe(true);
    await expect(workflows.read(profileId)).resolves.toEqual({
      records: [],
      degraded: true,
    });
  });

  it('clears quarantine degradation after a successful install rewrites the registry', async () => {
    const home = await temp('ignite-installed-workflows-rewrite-');
    const { fileSystem, store: workflows } = await store(home);
    const registryPath = fileSystem.getProfileInstalledWorkflowsPath(profileId);
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, '{not json', 'utf8');
    await expect(workflows.read(profileId)).resolves.toEqual({
      records: [],
      degraded: true,
    });
    await expect(workflows.read(profileId)).resolves.toEqual({
      records: [],
      degraded: true,
    });

    await workflows.writeInstalled(profileId, keyA, installed());

    await expect(workflows.read(profileId)).resolves.toEqual({
      records: [{ ...keyA, installed: installed() }],
      degraded: false,
    });
    expect(
      (await fs.readdir(path.dirname(registryPath))).some((entry) =>
        entry.startsWith('installed.json.corrupt-')
      )
    ).toBe(true);
  });

  it('keeps quarantine degradation across an attempted install until success rewrites it', async () => {
    const home = await temp('ignite-installed-workflows-quarantine-attempt-');
    const { fileSystem, store: workflows } = await store(home);
    const registryPath = fileSystem.getProfileInstalledWorkflowsPath(profileId);
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, '{not json', 'utf8');

    await workflows.read(profileId);
    await workflows.writeAttempt(profileId, keyA, attempt());

    await expect(workflows.read(profileId)).resolves.toMatchObject({
      degraded: true,
      records: [expect.objectContaining({ ...keyA, lastAttempt: attempt() })],
    });
    expect(JSON.parse(await fs.readFile(registryPath, 'utf8'))).toMatchObject({
      quarantinedAt: expect.any(String),
    });

    await workflows.writeInstalled(profileId, keyA, installed());
    await expect(workflows.read(profileId)).resolves.toMatchObject({
      degraded: false,
      records: [expect.objectContaining({ ...keyA, installed: installed() })],
    });
  });

  it('reports a fresh profile without a registry or quarantine as healthy', async () => {
    const home = await temp('ignite-installed-workflows-fresh-');
    const { store: workflows } = await store(home);

    await expect(workflows.read(profileId)).resolves.toEqual({
      records: [],
      degraded: false,
    });
  });

  it('quarantines an unknown schema version', async () => {
    const home = await temp('ignite-installed-workflows-schema-');
    const { fileSystem, store: workflows } = await store(home);
    const registryPath = fileSystem.getProfileInstalledWorkflowsPath(profileId);
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(
      registryPath,
      JSON.stringify({ schemaVersion: 2, records: [] })
    );

    await expect(workflows.read(profileId)).resolves.toEqual({
      records: [],
      degraded: true,
    });
    await expect(fs.access(registryPath)).rejects.toThrow();
  });

  it('preserves an opaque corrupt record across an unrelated install and remains degraded', async () => {
    const home = await temp('ignite-installed-workflows-opaque-');
    const { fileSystem, store: workflows } = await store(home);
    const registryPath = fileSystem.getProfileInstalledWorkflowsPath(profileId);
    const corruptA = { ...keyA, installed: { docHash: 'not-a-hash' } };
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(
      registryPath,
      JSON.stringify({ schemaVersion: 1, records: [corruptA] })
    );

    await workflows.writeInstalled(profileId, keyB, installed());

    await expect(workflows.read(profileId)).resolves.toMatchObject({
      degraded: true,
      records: [expect.objectContaining(keyB)],
    });
    expect(
      JSON.parse(await fs.readFile(registryPath, 'utf8')).records
    ).toContainEqual(corruptA);
  });

  it('repairs a corrupt record when writing its key and clears degraded state', async () => {
    const home = await temp('ignite-installed-workflows-repair-');
    const { fileSystem, store: workflows } = await store(home);
    const registryPath = fileSystem.getProfileInstalledWorkflowsPath(profileId);
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        records: [{ ...keyA, installed: { docHash: 'not-a-hash' } }],
      })
    );

    await workflows.writeInstalled(profileId, keyA, installed());

    await expect(workflows.read(profileId)).resolves.toMatchObject({
      degraded: false,
      records: [expect.objectContaining({ ...keyA, installed: installed() })],
    });
  });

  it('writeInstalled clears lastAttempt', async () => {
    const home = await temp('ignite-installed-workflows-success-');
    const { store: workflows } = await store(home);
    await workflows.writeAttempt(profileId, keyA, attempt());

    await workflows.writeInstalled(profileId, keyA, installed());

    expect(
      await workflows.get(profileId, keyA.repoPathOrUrl, keyA.name)
    ).toEqual({
      ...keyA,
      installed: installed(),
    });
  });

  it('writeAttempt preserves installed state', async () => {
    const home = await temp('ignite-installed-workflows-attempt-');
    const { store: workflows } = await store(home);
    await workflows.writeInstalled(profileId, keyA, installed());

    await workflows.writeAttempt(profileId, keyA, attempt());

    expect(
      await workflows.get(profileId, keyA.repoPathOrUrl, keyA.name)
    ).toEqual({
      ...keyA,
      installed: installed(),
      lastAttempt: attempt(),
    });
  });

  it('does not write when its guard returns false', async () => {
    const home = await temp('ignite-installed-workflows-guard-');
    const { fileSystem, store: workflows } = await store(home);

    await expect(
      workflows.writeInstalled(profileId, keyA, installed(), async () => false)
    ).resolves.toBe(false);

    await expect(
      fs.access(fileSystem.getProfileInstalledWorkflowsPath(profileId))
    ).rejects.toThrow();
    await expect(workflows.read(profileId)).resolves.toEqual({
      records: [],
      degraded: false,
    });
  });
});
