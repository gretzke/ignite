import { afterAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileSystem } from '../../filesystem/FileSystem.js';
import { assertNoUrlCredentials, canonicalGitUrl, VersionStore, pinnedOrigin, type VersionRecord } from '../../repos/VersionStore.js';
import { getLogger } from '../../utils/logger.js';

const dirs: string[] = [];
const commitA = 'a'.repeat(40);
const commitB = 'b'.repeat(40);
const urlA = 'https://github.com/Uniswap/v4-core.git';
const urlB = 'https://example.test/team/other-repo.git';

async function temp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function store(
  home: string
): Promise<{ fileSystem: FileSystem; store: VersionStore }> {
  FileSystem.resetInstance();
  const fileSystem = FileSystem.getInstance(home);
  return { fileSystem, store: new VersionStore(fileSystem) };
}

function record(url = urlA, commit = commitA): VersionRecord {
  return {
    url,
    commit,
    refLabel: 'v1.0.0',
    refKind: 'tag',
    createdAt: '2026-07-18T00:00:00.000Z',
    lastUsedAt: '2026-07-18T00:00:00.000Z',
  };
}

function storedRecord(url = urlA, commit = commitA): VersionRecord {
  return { ...record(url, commit), url: canonicalGitUrl(url) };
}

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe('VersionStore', () => {
  it.each([
    ['https://example.test/team/repo.git', 'https://example.test/team/repo'],
    ['https://example.test/team/repo.GIT/', 'https://example.test/team/repo'],
    ['git@github.com:team/repo.git', 'ssh://git@github.com/team/repo'],
    ['ssh://git@example.test/team/repo.git', 'ssh://git@example.test/team/repo'],
  ])('canonicalizes %s as %s', (input, expected) => {
    expect(canonicalGitUrl(input)).toBe(expected);
  });

  it('rejects credential-embedded HTTP URLs but accepts SSH user identities', () => {
    expect(() => assertNoUrlCredentials('https://user:pass@example.test/repo.git')).toThrow(
      expect.objectContaining({ code: 'VERSION_URL_CREDENTIALS' })
    );
    expect(() => assertNoUrlCredentials('https://token@example.test/repo.git')).toThrow(
      expect.objectContaining({ code: 'VERSION_URL_CREDENTIALS' })
    );
    expect(() => assertNoUrlCredentials('ssh://git@github.com/org/repo.git')).not.toThrow();
  });

  it('derives global cache paths using the pinned-store slug and URL hash conventions', async () => {
    const home = await temp('ignite-version-home-');
    const { fileSystem, store: versions } = await store(home);
    const hash = crypto
      .createHash('sha256')
      .update(canonicalGitUrl(urlA))
      .digest('hex')
      .slice(0, 8);
    const group = path.join(
      home,
      'repos',
      'cache',
      `github-com-uniswap-v4-core-${hash}`
    );

    expect(fileSystem.getVersionCachePath()).toBe(
      path.join(home, 'repos', 'cache')
    );
    expect(fileSystem.getVersionRegistryPath()).toBe(
      path.join(home, 'repos', 'cache.json')
    );
    expect(fileSystem.getVersionMembershipPath('p1')).toBe(
      path.join(home, 'profiles', 'p1', 'repos', 'versions.json')
    );
    expect(versions.groupDir(urlA)).toBe(group);
    expect(versions.bareRepoPath(urlA)).toBe(path.join(group, 'repo.git'));
    expect(versions.checkoutPath(urlA, commitA)).toBe(
      path.join(group, 'versions', commitA)
    );
    expect(path.basename(versions.checkoutPath(urlA, commitA))).toHaveLength(
      40
    );
  });

  it('normalizes scp remotes consistently for group identity and origin approval', async () => {
    const home = await temp('ignite-version-scp-');
    const { store: versions } = await store(home);
    const scp = 'git@github.com:org/repo.git';
    const ssh = 'ssh://git@github.com/org/repo.git';

    expect(versions.groupDir(scp)).toBe(versions.groupDir(ssh));
    expect(pinnedOrigin(scp)).toBe('ssh://github.com');
    expect(pinnedOrigin(scp)).toBe(pinnedOrigin(ssh));

    await versions.approveOrigins('p1', [scp]);
    await expect(versions.isOriginApproved('p1', scp)).resolves.toBe(true);
    await expect(versions.isOriginApproved('p1', ssh)).resolves.toBe(true);
  });

  it('uses one canonical membership key across scp and ssh aliases', async () => {
    const home = await temp('ignite-version-alias-');
    const { fileSystem, store: versions } = await store(home);
    const scp = 'git@github.com:org/repo.git';
    const ssh = 'ssh://git@github.com/org/repo.git';

    await fs.mkdir(path.dirname(fileSystem.getVersionMembershipPath('p1')), { recursive: true });
    await fs.writeFile(fileSystem.getVersionMembershipPath('p1'), JSON.stringify({
      [scp]: [{ commit: commitA, source: 'workflow', addedAt: '2026-07-18T00:00:00.000Z' }],
    }));

    expect(await versions.referenceCount(ssh, commitA)).toBe(1);
    await expect(versions.removeUserMembershipAndDeleteIfUnreferenced('p2', ssh, commitA, async () => {})).resolves.toEqual({
      membershipRemoved: false,
      checkoutDeleted: false,
    });
  });

  it('migrates a raw-URL cache group before reconciling a canonicalized record', async () => {
    const home = await temp('ignite-version-legacy-group-');
    const { fileSystem, store: versions } = await store(home);
    const scp = 'git@github.com:org/repo.git';
    const canonical = 'ssh://git@github.com/org/repo';
    const rawHash = crypto.createHash('sha256').update(scp).digest('hex').slice(0, 8);
    const rawGroup = path.join(
      fileSystem.getVersionCachePath(),
      `github-com-org-repo-${rawHash}`
    );
    await fs.mkdir(path.join(rawGroup, 'versions', commitA), { recursive: true });
    await fs.mkdir(path.dirname(fileSystem.getVersionRegistryPath()), { recursive: true });
    await fs.writeFile(
      fileSystem.getVersionRegistryPath(),
      JSON.stringify({ versions: [record(scp, commitA)] })
    );

    await versions.reconcile();

    expect(await versions.list()).toEqual([expect.objectContaining({
      ...storedRecord(canonical, commitA),
      lastError: expect.objectContaining({ code: 'INTERRUPTED' }),
    })]);
    await expect(fs.stat(versions.checkoutPath(canonical, commitA))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    await expect(fs.access(rawGroup)).rejects.toThrow();
  });

  it('merges duplicate .git records and transactionally keeps the detected legacy checkout', async () => {
    const home = await temp('ignite-version-duplicate-groups-');
    const { fileSystem, store: versions } = await store(home);
    const legacyUrl = 'https://example.test/acme/repo.git';
    const canonicalUrl = canonicalGitUrl(legacyUrl);
    const legacyHash = crypto
      .createHash('sha256')
      .update(legacyUrl)
      .digest('hex')
      .slice(0, 8);
    const legacyGroup = path.join(
      fileSystem.getVersionCachePath(),
      `example-test-acme-repo-${legacyHash}`
    );
    const canonicalCheckout = versions.checkoutPath(canonicalUrl, commitA);
    const legacyCheckout = path.join(legacyGroup, 'versions', commitA);
    await fs.mkdir(canonicalCheckout, { recursive: true });
    await fs.mkdir(legacyCheckout, { recursive: true });
    await fs.writeFile(path.join(canonicalCheckout, 'winner.txt'), 'canonical');
    await fs.writeFile(path.join(legacyCheckout, 'winner.txt'), 'legacy');
    await fs.mkdir(path.dirname(fileSystem.getVersionRegistryPath()), { recursive: true });
    await fs.writeFile(
      fileSystem.getVersionRegistryPath(),
      JSON.stringify({
        versions: [
          {
            ...record(canonicalUrl, commitA),
            lastUsedAt: '2026-07-20T00:00:00.000Z',
          },
          {
            ...record(legacyUrl, commitA),
            refLabel: 'v1.0.0',
            refKind: 'tag',
            detectedAt: '2026-07-21T00:00:00.000Z',
          },
        ],
      })
    );

    await versions.reconcile();

    expect(await versions.list()).toEqual([
      expect.objectContaining({
        url: canonicalUrl,
        refLabel: 'v1.0.0',
        refKind: 'tag',
        detectedAt: '2026-07-21T00:00:00.000Z',
      }),
    ]);
    await expect(fs.readFile(path.join(canonicalCheckout, 'winner.txt'), 'utf8')).resolves.toBe('legacy');
    await expect(fs.access(legacyGroup)).rejects.toThrow();
  });

  it('round-trips global records and only removes registry entries', async () => {
    const home = await temp('ignite-version-home-');
    const { store: versions } = await store(home);
    const checkout = versions.checkoutPath(urlA, commitA);
    await fs.mkdir(checkout, { recursive: true });

    await versions.upsert(record());
    await versions.upsert(record(urlA, commitB));
    expect(await versions.get(urlA, commitA)).toMatchObject(storedRecord());
    expect(await versions.list()).toHaveLength(2);

    await versions.remove(urlA, commitA);
    expect(await versions.get(urlA, commitA)).toBeUndefined();
    await expect(fs.stat(checkout)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });

  it('stores source-tagged memberships and counts all references across profiles', async () => {
    const home = await temp('ignite-version-home-');
    const { store: versions } = await store(home);

    await versions.addMembership('p1', urlA, commitA, 'user');
    await versions.addMembership('p1', urlA, commitA, 'workflow');
    await versions.addMembership('p2', urlA, commitA, 'workflow');
    await versions.addMembership('p2', urlA, commitB, 'user');

    expect((await versions.listMemberships('p1'))[canonicalGitUrl(urlA)]).toEqual([
      { commit: commitA, addedAt: expect.any(String), source: 'user' },
      { commit: commitA, addedAt: expect.any(String), source: 'workflow' },
    ]);
    expect(await versions.referenceCount(urlA, commitA)).toBe(3);
    expect(await versions.referenceCount(urlA, commitB)).toBe(1);
  });

  it('removes only a user membership while retaining the workflow reference', async () => {
    const home = await temp('ignite-version-home-');
    const { store: versions } = await store(home);
    await versions.addMembership('p1', urlA, commitA, 'user');
    await versions.addMembership('p1', urlA, commitA, 'workflow');

    await versions.removeMembership('p1', urlA, commitA);

    expect((await versions.listMemberships('p1'))[canonicalGitUrl(urlA)]).toEqual([
      { commit: commitA, addedAt: expect.any(String), source: 'workflow' },
    ]);
    expect(await versions.referenceCount(urlA, commitA)).toBe(1);
  });

  it('removes a caller membership but retains a checkout referenced by another profile', async () => {
    const home = await temp('ignite-version-remove-');
    const { store: versions } = await store(home);
    await versions.upsert(record());
    await versions.addMembership('p1', urlA, commitA, 'user');
    await versions.addMembership('p2', urlA, commitA, 'workflow');
    const remove = vi.fn(async () => {});

    await expect(
      versions.removeUserMembershipAndDeleteIfUnreferenced(
        'p1',
        urlA,
        commitA,
        remove
      )
    ).resolves.toEqual({ membershipRemoved: true, checkoutDeleted: false });
    expect(remove).not.toHaveBeenCalled();
    expect((await versions.listMemberships('p1'))[canonicalGitUrl(urlA)]).toBeUndefined();

    await expect(
      versions.removeUserMembershipAndDeleteIfUnreferenced(
        'p1',
        urlA,
        commitA,
        remove
      )
    ).resolves.toEqual({ membershipRemoved: false, checkoutDeleted: false });
  });

  it('bumps lastUsedAt without changing the original record metadata', async () => {
    const home = await temp('ignite-version-home-');
    const { store: versions } = await store(home);
    await versions.upsert(record());
    const before = (await versions.get(urlA, commitA))?.lastUsedAt;

    await new Promise((resolve) => setTimeout(resolve, 2));
    await versions.bumpLastUsed(urlA, commitA);

    expect(await versions.get(urlA, commitA)).toMatchObject({
      refLabel: 'v1.0.0',
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    expect((await versions.get(urlA, commitA))?.lastUsedAt).not.toBe(before);
  });

  it('updates global version state and retains per-profile origin approvals', async () => {
    const home = await temp('ignite-version-home-');
    const { store: versions } = await store(home);
    await versions.upsert(record());

    await versions.updateState(urlA, commitA, {
      detectedAt: '2026-07-18T01:00:00.000Z',
      compiledWith: [{ pluginId: 'foundry', version: '1.2.3' }],
    });
    await versions.approveOrigins('p1', ['https://github.com']);

    expect(await versions.get(urlA, commitA)).toMatchObject({
      detectedAt: '2026-07-18T01:00:00.000Z',
      compiledWith: [{ pluginId: 'foundry', version: '1.2.3' }],
    });
    expect(await versions.isOriginApproved('p1', urlA)).toBe(true);
    expect(await versions.isOriginApproved('p2', urlA)).toBe(false);
  });

  it('normalizes legacy single-compiler metadata when reading the registry', async () => {
    const home = await temp('ignite-version-legacy-compiler-');
    const { fileSystem, store: versions } = await store(home);
    await fs.mkdir(path.dirname(fileSystem.getVersionRegistryPath()), { recursive: true });
    await fs.writeFile(
      fileSystem.getVersionRegistryPath(),
      JSON.stringify({
        versions: [
          {
            ...record(),
            compiledWith: { pluginId: 'foundry', version: '1.2.3' },
          },
        ],
      })
    );

    await expect(versions.get(urlA, commitA)).resolves.toMatchObject({
      compiledWith: [{ pluginId: 'foundry', version: '1.2.3' }],
    });
  });

  it('sets and clears durable version failures with a null lastError patch', async () => {
    const home = await temp('ignite-version-errors-');
    const { store: versions } = await store(home);
    await versions.upsert(record());
    const lastError = { code: 'COMPILE_FAILED', message: 'compile failed', at: '2026-07-21T00:00:00.000Z' };

    await versions.updateState(urlA, commitA, { lastError });
    expect(await versions.get(urlA, commitA)).toMatchObject({ lastError });

    await versions.updateState(urlA, commitA, { lastError: null });
    expect((await versions.get(urlA, commitA))?.lastError).toBeUndefined();
  });

  it('marks only incomplete checkout-bearing records as interrupted during reconcile', async () => {
    const home = await temp('ignite-version-interrupted-');
    const { store: versions } = await store(home);
    const interrupted = record(urlA, commitA);
    const detected = { ...record(urlA, commitB), detectedAt: '2026-07-21T00:00:00.000Z' };
    const failed = { ...record(urlA, 'c'.repeat(40)), lastError: { code: 'CANCELLED', message: 'cancelled', at: '2026-07-21T00:00:00.000Z' } };
    for (const entry of [interrupted, detected, failed]) {
      await versions.upsert(entry);
      await fs.mkdir(versions.checkoutPath(entry.url, entry.commit), { recursive: true });
    }

    await versions.reconcile();

    expect((await versions.get(urlA, commitA))?.lastError).toMatchObject({ code: 'INTERRUPTED' });
    expect((await versions.get(urlA, commitB))?.lastError).toBeUndefined();
    expect((await versions.get(urlA, 'c'.repeat(40)))?.lastError).toMatchObject({ code: 'CANCELLED' });
  });

  it('tolerates a corrupt global registry as an empty registry and warns', async () => {
    const home = await temp('ignite-version-home-');
    const { fileSystem, store: versions } = await store(home);
    await fs.mkdir(path.dirname(fileSystem.getVersionRegistryPath()), {
      recursive: true,
    });
    await fs.writeFile(
      fileSystem.getVersionRegistryPath(),
      '{not json',
      'utf8'
    );
    const warning = vi
      .spyOn(getLogger(), 'warn')
      .mockImplementation(() => undefined);

    expect(await versions.list()).toEqual([]);
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });

  it('drops malformed registry records during reconcile while preserving valid records', async () => {
    const home = await temp('ignite-version-home-');
    const { fileSystem, store: versions } = await store(home);
    const valid = record();
    await fs.mkdir(versions.checkoutPath(urlA, commitA), { recursive: true });
    await fs.mkdir(path.dirname(fileSystem.getVersionRegistryPath()), { recursive: true });
    await fs.writeFile(
      fileSystem.getVersionRegistryPath(),
      JSON.stringify({ versions: [null, { nope: true }, valid] })
    );
    const warning = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);

    await expect(versions.reconcile()).resolves.toBeUndefined();
    expect(await versions.list()).toEqual([expect.objectContaining({
      ...storedRecord(),
      lastError: expect.objectContaining({ code: 'INTERRUPTED' }),
    })]);
    expect(warning).toHaveBeenCalledWith(
      'Ignoring invalid version cache registry record(s)'
    );
    warning.mockRestore();
  });

  it('reconcile drops memberships for versions absent from the reconciled registry', async () => {
    const home = await temp('ignite-version-home-');
    const { store: versions } = await store(home);
    await versions.addMembership('p1', urlA, commitA, 'workflow');
    await versions.reconcile();
    expect(await versions.listMemberships('p1')).toEqual({});
  });

  it('reconciles stale registry records and orphan or temporary checkout directories', async () => {
    const home = await temp('ignite-version-home-');
    const { fileSystem, store: versions } = await store(home);
    const live = record(urlA, commitA);
    const stale = record(urlA, commitB);
    const orphanCommit = 'c'.repeat(40);
    await versions.upsert(live);
    await versions.upsert(stale);
    await fs.mkdir(versions.checkoutPath(urlA, commitA), { recursive: true });
    await fs.mkdir(versions.checkoutPath(urlA, orphanCommit), {
      recursive: true,
    });
    await fs.mkdir(path.join(versions.groupDir(urlA), 'tmp-interrupted'), {
      recursive: true,
    });
    await fs.mkdir(
      path.join(
        fileSystem.getVersionCachePath(),
        'unknown-group',
        'versions',
        commitB
      ),
      { recursive: true }
    );
    await fs.mkdir(
      path.join(
        fileSystem.getVersionCachePath(),
        'unknown-group',
        'tmp-unknown'
      ),
      { recursive: true }
    );

    await versions.reconcile();

    expect(await versions.list()).toEqual([expect.objectContaining({
      ...storedRecord(urlA, commitA),
      lastError: expect.objectContaining({ code: 'INTERRUPTED' }),
    })]);
    await expect(
      fs.access(versions.checkoutPath(urlA, orphanCommit))
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(versions.groupDir(urlA), 'tmp-interrupted'))
    ).rejects.toThrow();
    await expect(
      fs.access(
        path.join(
          fileSystem.getVersionCachePath(),
          'unknown-group',
          'versions',
          commitB
        )
      )
    ).rejects.toThrow();
    await expect(
      fs.access(
        path.join(
          fileSystem.getVersionCachePath(),
          'unknown-group',
          'tmp-unknown'
        )
      )
    ).rejects.toThrow();
  });

  it('tolerates reconcile on a fresh install with no cache root', async () => {
    const home = await temp('ignite-version-home-');
    const { fileSystem, store: versions } = await store(home);

    await expect(versions.reconcile()).resolves.toBeUndefined();
    await expect(fs.access(fileSystem.getVersionCachePath())).rejects.toThrow();
  });

  it('serializes concurrent registry upserts so records for separate URLs are retained', async () => {
    const home = await temp('ignite-version-home-');
    const { store: versions } = await store(home);

    await Promise.all([
      versions.upsert(record(urlA, commitA)),
      versions.upsert(record(urlB, commitB)),
    ]);

    expect(await versions.list()).toEqual(
      expect.arrayContaining([
        storedRecord(urlA, commitA),
        storedRecord(urlB, commitB),
      ])
    );
  });

  it('only recognizes paths whose resolved location is inside the version cache', async () => {
    const home = await temp('ignite-version-home-');
    const outside = await temp('ignite-version-outside-');
    const { fileSystem, store: versions } = await store(home);
    const inside = path.join(
      fileSystem.getVersionCachePath(),
      'group',
      'versions',
      commitA
    );
    await fs.mkdir(inside, { recursive: true });
    await fs.symlink(
      outside,
      path.join(fileSystem.getVersionCachePath(), 'outside-link')
    );

    expect(versions.isCachePath(inside)).toBe(true);
    expect(
      versions.isCachePath(
        path.join(fileSystem.getVersionCachePath(), 'outside-link', 'repo')
      )
    ).toBe(false);
    expect(
      versions.isCachePath(path.join(home, 'repos', 'cache-not-a-match'))
    ).toBe(false);
  });
});
