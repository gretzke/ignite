// End-to-end verification of Spec B: install a plugin from a git URL via the
// real GitSourceBuildBackend + IsolatedBuilder, prove the build happens with
// no host/network access (egress-filtered rootless BuildKit), that the
// resulting image loads on the host, and that the standard untrusted-by-
// default permission gate still applies to it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Docker from 'dockerode';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileSystem } from '../filesystem/FileSystem.js';

// Sandbox the ignite home BEFORE any singleton resolves it (see Spec A Task 8).
const IGNITE_HOME = await mkdtemp(path.join(tmpdir(), 'ignite-b-e2e-'));
FileSystem.getInstance(IGNITE_HOME);

const { PluginInstaller } = await import(
  '../plugins/install/PluginInstaller.js'
);
const { GitSourceBuildBackend } = await import(
  '../plugins/install/GitSourceBuildBackend.js'
);
const { PluginExecutor } = await import(
  '../plugins/containers/PluginExecutor.js'
);
const { TrustManager } = await import('../plugins/trust/TrustManager.js');

const docker = new Docker();
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'git-plugin'
);

// The only prerequisite left (Phase 3 deleted the native base_repo-manager
// image + repo-container tier): Docker itself. Compiler containers now
// bind-mount the host workspace directly, so every assertion below —
// including the full post-approval compile — runs whenever Docker is
// present.
async function pingReady(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}
const dockerReady = await pingReady();

describe.skipIf(!dockerReady)('isolated git-source build (Docker)', () => {
  let repoDir: string;
  const installer = new PluginInstaller(new GitSourceBuildBackend());

  beforeAll(async () => {
    // Turn the fixture into a local git repo so we can install from a file://
    // URL, then run the real install-through-isolated-build once so every
    // assertion below shares the same installed plugin. This directory also
    // doubles as the host workspace the ephemeral compiler container binds
    // (LOCAL repos: the host path IS the workspace).
    repoDir = await mkdtemp(path.join(tmpdir(), 'ignite-gitrepo-'));
    await cp(FIXTURE, repoDir, { recursive: true });
    const run = (args: string[]) =>
      spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
    run(['init', '-q']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);
    run(['add', '-A']);
    run(['commit', '-q', '-m', 'fixture']);
  }, 600_000);

  afterAll(async () => {
    try {
      await installer.uninstall('git-fixture');
    } catch {
      /* best effort */
    }
    await rm(repoDir, { recursive: true, force: true }).catch(() => {});
    await rm(IGNITE_HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('clones, builds in isolation, installs untrusted, and gates compile until approved', async () => {
    const meta = await installer.install({
      kind: 'git',
      url: `file://${repoDir}`,
    });
    expect(meta.id).toBe('git-fixture');
    // The built image exists on the host after the isolated build + load.
    await docker.getImage(meta.baseImage).inspect();

    // Untrusted by default → compile denied, no container created. The gate
    // lives in PluginExecutor.execute before any container/workspace work,
    // so it fires even without a workspacePath.
    const denied = await PluginExecutor.getInstance().execute(
      'git-fixture',
      'compile',
      { pathOrUrl: repoDir }
    );
    expect(denied.success).toBe(false);
    if (!denied.success) {
      expect(denied.error.code).toBe('PERMISSION_REQUIRED');
      expect(denied.error.details).toMatchObject({
        pluginId: 'git-fixture',
        permission: 'hostWrite',
      });
    }

    // Approve hostWrite → the permission gate now passes: compile is no
    // longer PERMISSION_REQUIRED.
    await TrustManager.getInstance().setTrust('git-fixture', 'trusted', {
      hostWrite: true,
      net: false,
    });
    const afterApproval = await PluginExecutor.getInstance().execute(
      'git-fixture',
      'compile',
      { pathOrUrl: repoDir },
      { workspacePath: repoDir }
    );
    if (!afterApproval.success) {
      expect(afterApproval.error.code).not.toBe('PERMISSION_REQUIRED');
    }
  }, 600_000);

  it(
    'runs a full compile after approval, writing the workspace marker',
    async () => {
      // Idempotent: the gate test above already approved, but assert trust
      // here too so this test does not depend on inter-test ordering.
      await TrustManager.getInstance().setTrust('git-fixture', 'trusted', {
        hostWrite: true,
        net: false,
      });

      // The compile runs from the isolated-build image, with hostWrite
      // approved, against the host workspace directly bind-mounted (no repo
      // container — Phase 3 deleted that tier).
      const ok = await PluginExecutor.getInstance().execute(
        'git-fixture',
        'compile',
        { pathOrUrl: repoDir },
        { workspacePath: repoDir }
      );
      expect(ok.success).toBe(true);

      // Prove hostWrite actually happened: the fixture's compile() wrote a
      // marker into /workspace, which is bind-mounted from repoDir.
      const fs = await import('node:fs/promises');
      const marker = await fs.readFile(
        path.join(repoDir, '.git-fixture-ran'),
        'utf8'
      );
      expect(marker.trim().length).toBeGreaterThan(0);
    },
    600_000
  );

  // Egress-enforcement proof (Step 4). The brief's suggested single self-
  // validating RUN line (`if <probe>; then echo blocked-ok; else echo
  // blocked-ok; fi`) echoes the same string on both branches, so a
  // successful build never actually distinguishes "blocked" from "not
  // blocked" — it was flagged in the brief as possibly awkward, with an
  // explicit fallback authorized: split into two builds, one that must
  // succeed (public egress) and one that must fail the build (host
  // reachability). That's what these two tests do. Neither `curl` nor
  // `wget` exist in node:22-slim, and Node's core http/https client does
  // not honor HTTP_PROXY, so each probe is a small inline Node script:
  // the public probe manually speaks the forward-proxy protocol (absolute-
  // URI request sent to the proxy's own host:port, which the private
  // network CAN reach), and the host probe opens a raw TCP connection
  // straight to host.docker.internal, bypassing the proxy entirely to
  // prove the network path itself doesn't exist.
  it('build can reach the public internet through the egress proxy', async () => {
    const { IsolatedBuilder } = await import(
      '../plugins/install/IsolatedBuilder.js'
    );
    const fs = await import('node:fs/promises');
    const probeDir = await mkdtemp(path.join(tmpdir(), 'ignite-probe-pub-'));
    const probe = [
      "const http = require('http');",
      "const proxyEnv = process.env.HTTP_PROXY || process.env.http_proxy || '';",
      "const proxy = proxyEnv.replace(/^https?:\\/\\//, '');",
      "const [host, portStr] = proxy.split(':');",
      'if (!host) {',
      "  console.error('no HTTP_PROXY env set inside build');",
      '  process.exit(1);',
      '}',
      '// Forward-proxy request: absolute-URI path sent straight to the proxy,',
      '// which is on the reachable internal network and does the real fetch.',
      'const req = http.request(',
      "  { host, port: Number(portStr), path: 'http://example.com/', method: 'GET', timeout: 8000 },",
      '  (res) => {',
      '    res.resume();',
      '    res.on("end", () => {',
      '      console.log("public fetch via proxy status", res.statusCode);',
      '      process.exit(res.statusCode && res.statusCode < 500 ? 0 : 1);',
      '    });',
      '  }',
      ');',
      'req.on("error", (e) => { console.error("public fetch error", e.message); process.exit(1); });',
      'req.on("timeout", () => { req.destroy(); process.exit(1); });',
      'req.end();',
    ].join('\n');
    await fs.writeFile(path.join(probeDir, 'probe.cjs'), probe);
    await fs.writeFile(
      path.join(probeDir, 'Dockerfile'),
      [
        'FROM node:22-slim',
        'COPY probe.cjs /tmp/probe.cjs',
        'RUN node /tmp/probe.cjs',
      ].join('\n')
    );
    const tag = await new IsolatedBuilder().buildToTempTag(
      probeDir,
      'Dockerfile'
    );
    expect(tag).toContain('ignite/installing_git_');
    await docker
      .getImage(tag)
      .remove({ force: true })
      .catch(() => {});
    await rm(probeDir, { recursive: true, force: true }).catch(() => {});
  }, 600_000);

  it('build cannot reach the host/local network (build fails)', async () => {
    const { IsolatedBuilder } = await import(
      '../plugins/install/IsolatedBuilder.js'
    );
    const fs = await import('node:fs/promises');
    const probeDir = await mkdtemp(path.join(tmpdir(), 'ignite-probe-host-'));
    const probe = [
      "const net = require('net');",
      "const sock = net.createConnection({ host: 'host.docker.internal', port: 1301, timeout: 5000 });",
      'sock.on("connect", () => {',
      '  console.log("UNEXPECTED: connected to host.docker.internal");',
      '  sock.destroy();',
      '  process.exit(0);',
      '});',
      'sock.on("error", (e) => { console.log("expected: cannot reach host -", e.message); process.exit(1); });',
      'sock.on("timeout", () => { console.log("expected: connection timed out"); sock.destroy(); process.exit(1); });',
    ].join('\n');
    await fs.writeFile(path.join(probeDir, 'probe.cjs'), probe);
    await fs.writeFile(
      path.join(probeDir, 'Dockerfile'),
      [
        'FROM node:22-slim',
        'COPY probe.cjs /tmp/probe.cjs',
        'RUN node /tmp/probe.cjs',
      ].join('\n')
    );
    // The RUN step exits non-zero when the connection is refused/unreachable
    // (the expected outcome), which fails the Dockerfile build itself.
    await expect(
      new IsolatedBuilder().buildToTempTag(probeDir, 'Dockerfile')
    ).rejects.toThrow();
    await rm(probeDir, { recursive: true, force: true }).catch(() => {});
  }, 600_000);
});
