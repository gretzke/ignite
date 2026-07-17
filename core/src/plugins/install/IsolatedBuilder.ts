import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { getLogger } from '../../utils/logger.js';
import { runCommand } from '../../utils/runCommand.js';
import { ownerLabels } from '../../system/orphanSweep.js';

// Squid egress ACL: deny loopback + RFC1918 + link-local (IPv4 and IPv6)
// BEFORE allowing the rest of the internet (squid evaluates rules
// top-to-bottom). host.docker.internal resolves inside 192.168.0.0/16 on
// Docker Desktop, so the generic RFC1918 rule covers it. The IPv6 ranges
// (::1 loopback, fc00::/7 ULA, fe80::/10 link-local, ::ffff:0:0/96
// IPv4-mapped) close off the same classes of address over IPv6 so the ACL
// matches its documented contract even if the sandbox ever gains IPv6
// connectivity. This is the policy layer; the --internal network is the
// enforcement layer (a build ignoring the proxy env has no route out at all).
export const SQUID_CONF = `acl SSL_ports port 443
acl CONNECT method CONNECT
acl private_dst dst 127.0.0.0/8
acl private_dst dst 10.0.0.0/8
acl private_dst dst 172.16.0.0/12
acl private_dst dst 192.168.0.0/16
acl private_dst dst 169.254.0.0/16
acl private_dst dst ::1/128
acl private_dst dst fc00::/7
acl private_dst dst fe80::/10
acl private_dst dst ::ffff:0:0/96
http_access deny private_dst
http_access allow CONNECT SSL_ports
http_access allow all
http_port 3128
`;

const BUILDKIT_IMAGE = 'moby/buildkit:rootless';
const SQUID_IMAGE = 'ubuntu/squid:latest';
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

// Run a docker CLI command, capturing stdout; reject on non-zero exit.
async function dockerCli(args: string[], timeoutMs = 60_000): Promise<string> {
  const result = await runCommand('docker', args, { timeoutMs });
  if (result.code !== 0) {
    throw new Error(
      `docker ${args.join(' ')} failed (exit ${result.code}): ${result.stderr.trim()}`
    );
  }
  return result.stdout;
}

// Sleep helper for the squid-readiness poll below.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Builds an untrusted plugin source in an isolated, host-inaccessible sandbox
// and loads the result into the host daemon. Every resource it creates is torn
// down in finally (ephemeral per build).
export class IsolatedBuilder {
  // contextDir: host dir to use as the Docker build context.
  // dockerfileRel: path of the Dockerfile relative to contextDir.
  // Returns the loaded host image tag (ignite/installing_git_<rand>:build).
  async buildToTempTag(
    contextDir: string,
    dockerfileRel: string
  ): Promise<string> {
    const id = randomBytes(4).toString('hex');
    const internalNet = `ignite-build-internal-${id}`;
    const egressNet = `ignite-build-egress-${id}`;
    const proxy = `ignite-build-proxy-${id}`;
    const builder = `ignite-buildkitd-${id}`;
    const tempTag = `ignite/installing_git_${id}:build`;
    const ownerLabelArgs = Object.entries(ownerLabels('build')).flatMap(
      ([key, value]) => ['--label', `${key}=${value}`]
    );
    // NOTE: proxyUrl is resolved to the proxy's internal-network IP, not its
    // container name, further down (see the comment at that assignment).
    let proxyUrl = '';

    getLogger().info(`🔒 Starting isolated build ${id} from ${contextDir}`);

    try {
      // 1. Networks: internal (no route out) + egress (normal bridge).
      await dockerCli([
        'network',
        'create',
        '--internal',
        ...ownerLabelArgs,
        internalNet,
      ]);
      await dockerCli(['network', 'create', ...ownerLabelArgs, egressNet]);

      // 2. Egress proxy: start on the internal net, write its config, then
      //    dual-home it onto the egress net (the ONLY container with a route out).
      await dockerCli([
        'run',
        '-d',
        '--name',
        proxy,
        '--network',
        internalNet,
        ...ownerLabelArgs,
        SQUID_IMAGE,
      ]);
      // RUN-step processes execute inside buildkitd's rootless (rootlesskit
      // + slirp4netns) inner network namespace, which is NOT the buildkitd
      // container's own Docker network namespace: it ships its own resolver
      // (hardcoded public nameservers) that cannot see Docker's embedded DNS,
      // so container-name lookups (e.g. `http://ignite-build-proxy-xxxx:3128`)
      // always fail there with EAI_AGAIN even though the container name
      // resolves fine via `docker exec`. Raw IP traffic on the internal
      // network DOES reach the proxy from inside a RUN step, so resolve the
      // proxy's own IP on internalNet up front and address it by IP instead
      // — otherwise every RUN step that touches the network (npm install,
      // apt-get, pip, curl, wget — anything that honors HTTP(S)_PROXY) would
      // silently fail to reach the egress proxy at all.
      const proxyIp = await this.getContainerIp(proxy, internalNet);
      proxyUrl = `http://${proxyIp}:3128`;
      // Write the ACL config into the running proxy and reload it. Squid
      // needs a moment to finish its own startup before `-k reconfigure`
      // (or a plain exec) will succeed, so poll briefly instead of a single
      // fixed sleep.
      await this.waitForSquidReady(proxy);
      await this.writeFileInContainer(
        proxy,
        '/etc/squid/squid.conf',
        SQUID_CONF
      );
      await dockerCli(['exec', proxy, 'squid', '-k', 'reconfigure']).catch(
        // squid may still be starting; a short retry via restart is simplest.
        async () => {
          await dockerCli(['restart', proxy]);
          await this.waitForSquidReady(proxy);
        }
      );
      await dockerCli(['network', 'connect', egressNet, proxy]);

      // 3. Rootless buildkitd, attached ONLY to the internal net, egress via proxy.
      await dockerCli([
        'run',
        '-d',
        '--name',
        builder,
        '--network',
        internalNet,
        ...ownerLabelArgs,
        '--security-opt',
        'seccomp=unconfined',
        '--security-opt',
        'apparmor=unconfined',
        '-e',
        `HTTP_PROXY=${proxyUrl}`,
        '-e',
        `HTTPS_PROXY=${proxyUrl}`,
        '-e',
        `http_proxy=${proxyUrl}`,
        '-e',
        `https_proxy=${proxyUrl}`,
        '-e',
        'NO_PROXY=',
        BUILDKIT_IMAGE,
        '--oci-worker-no-process-sandbox',
      ]);
      await this.assertUnprivileged(builder, internalNet);
      await this.waitForBuildkitReady(builder);

      // 4. Copy source into the builder and build to a docker-format tarball.
      await dockerCli(['exec', builder, 'mkdir', '-p', '/tmp/src']);
      await dockerCli(['cp', `${contextDir}/.`, `${builder}:/tmp/src`]);

      const dfDir = dockerfileRel.includes('/')
        ? `/tmp/src/${dockerfileRel.slice(0, dockerfileRel.lastIndexOf('/'))}`
        : '/tmp/src';
      const dfName = dockerfileRel.slice(dockerfileRel.lastIndexOf('/') + 1);

      // Decisive readiness gate: the proxy's final config was applied (or
      // the container was restarted) and it was reattached to the egress
      // net above, but neither of those guarantees squid is listening yet.
      // Confirm it here, immediately before the build starts, so buildkitd's
      // base-image pull can never hit the proxy before it accepts
      // connections (the root cause of the intermittent ECONNREFUSED).
      await this.waitForSquidReady(proxy);

      getLogger().info(`🔨 Isolated build ${id}: running buildctl build`);
      await dockerCli(
        [
          'exec',
          builder,
          'buildctl',
          'build',
          '--frontend',
          'dockerfile.v0',
          '--local',
          'context=/tmp/src',
          '--local',
          `dockerfile=${dfDir}`,
          '--opt',
          `filename=${dfName}`,
          '--opt',
          `build-arg:HTTP_PROXY=${proxyUrl}`,
          '--opt',
          `build-arg:HTTPS_PROXY=${proxyUrl}`,
          '--opt',
          `build-arg:http_proxy=${proxyUrl}`,
          '--opt',
          `build-arg:https_proxy=${proxyUrl}`,
          '--output',
          `type=docker,name=${tempTag},dest=/tmp/out.tar`,
        ],
        BUILD_TIMEOUT_MS
      );

      // 5. Move the tarball out and load it on the host daemon.
      await dockerCli(['exec', builder, 'test', '-f', '/tmp/out.tar']);
      // `docker cp` of a container path streams the file as a raw tar entry
      // (not double-wrapped) when the source is a single file, so this is
      // safe to load directly.
      await this.loadFromContainer(builder, '/tmp/out.tar');

      getLogger().info(`✅ Isolated build ${id} produced ${tempTag}`);
      return tempTag;
    } finally {
      // Best-effort teardown of everything created, in reverse order.
      for (const c of [builder, proxy]) {
        await dockerCli(['rm', '-f', '-v', c]).catch((err) => {
          getLogger().warn(`Isolated build cleanup: failed to remove ${c}: ${err}`);
        });
      }
      for (const n of [egressNet, internalNet]) {
        await dockerCli(['network', 'rm', n]).catch((err) => {
          getLogger().warn(`Isolated build cleanup: failed to remove network ${n}: ${err}`);
        });
      }
    }
  }

  // Resolve a container's IPv4 address on a given Docker network, for
  // addressing it from inside a RUN step's rootless network sandbox where
  // Docker's embedded DNS is unreachable (see the comment above its call site).
  private async getContainerIp(
    container: string,
    network: string
  ): Promise<string> {
    const out = await dockerCli([
      'inspect',
      '--format',
      `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
      container,
    ]);
    const ip = out.trim();
    if (!ip) {
      throw new Error(
        `Could not resolve IP of ${container} on network ${network}`
      );
    }
    return ip;
  }

  // Fail closed if the builder somehow came up privileged, with the docker
  // socket mounted, or attached to any network other than the isolated
  // internal one (e.g. the egress net, a user-defined bridge, or host
  // networking) — the internal-only network attachment is the property that
  // actually keeps untrusted build code from reaching the host or the wider
  // network, so it's checked as strictly as the other two.
  private async assertUnprivileged(
    container: string,
    internalNet: string
  ): Promise<void> {
    const out = await dockerCli([
      'inspect',
      '--format',
      '{{.HostConfig.Privileged}}|{{range .Mounts}}{{.Source}},{{end}}|' +
        '{{range $k,$v := .NetworkSettings.Networks}}{{$k}},{{end}}',
      container,
    ]);
    const [priv, mounts = '', networksRaw = ''] = out.trim().split('|');
    if (priv === 'true') {
      throw new Error(
        'Isolated builder came up privileged — refusing to build'
      );
    }
    if (mounts.includes('docker.sock')) {
      throw new Error(
        'Isolated builder has the docker socket mounted — refusing'
      );
    }
    const networks = networksRaw.split(',').filter(Boolean);
    const unique = new Set(networks);
    if (unique.size !== 1 || !unique.has(internalNet)) {
      throw new Error(
        `Isolated builder is attached to unexpected network(s) [${networks.join(', ') || 'none'}] ` +
          `— expected exactly [${internalNet}], refusing to build`
      );
    }
  }

  // Poll until squid is actually accepting TCP connections on 3128 — NOT
  // just until `/etc/squid` exists (that directory is baked into the image
  // and is present instantly, long before the squid process is listening).
  // ubuntu/squid is Ubuntu-based (has bash), so probe with a bash /dev/tcp
  // connect: it exits 0 only when something is listening on the port. Squid
  // binds 0.0.0.0:3128 (http_port 3128), so loopback readiness implies the
  // internal-net IP is ready too. On exhaustion this throws rather than
  // silently falling through — a proxy that never starts listening must fail
  // the build loudly instead of proceeding into a confusing ECONNREFUSED
  // once buildkitd starts pulling through it.
  private async waitForSquidReady(
    container: string,
    attempts = 20,
    delayMs = 250
  ): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await dockerCli([
          'exec',
          container,
          'bash',
          '-c',
          'exec 3<>/dev/tcp/127.0.0.1/3128',
        ]);
        return;
      } catch {
        await sleep(delayMs);
      }
    }
    throw new Error(
      `squid proxy in ${container} did not start accepting connections on port 3128 in time`
    );
  }

  // Poll until buildctl can reach the buildkitd daemon socket, so step 4
  // doesn't race rootlesskit's startup (which can take a beat longer than a
  // plain container to report "running").
  private async waitForBuildkitReady(
    container: string,
    attempts = 40,
    delayMs = 250
  ): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await dockerCli(['exec', container, 'buildctl', 'debug', 'workers']);
        return;
      } catch {
        await sleep(delayMs);
      }
    }
    throw new Error(
      `buildkitd in ${container} did not become ready in time`
    );
  }

  // Write text into a file inside a running container without a host temp file.
  private writeFileInContainer(
    container: string,
    path: string,
    content: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'docker',
        ['exec', '-i', container, 'sh', '-c', `cat > ${path}`],
        { stdio: ['pipe', 'ignore', 'pipe'] }
      );
      let stderr = '';
      child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`write ${path} failed (exit ${code}): ${stderr}`))
      );
      child.stdin?.end(content);
    });
  }

  // `docker exec <container> cat <path>` streams the raw file bytes (unlike
  // `docker cp` which wraps the result in its own tar envelope); pipe that
  // directly into `docker load`, which expects a raw tarball on stdin.
  private loadFromContainer(container: string, path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const cp = spawn('docker', ['exec', container, 'cat', path], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const load = spawn('docker', ['load'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      cp.stdout.pipe(load.stdin);
      cp.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      load.stdout?.on('data', (c: Buffer) => {
        getLogger().debug(`docker load: ${c.toString('utf8').trim()}`);
      });
      load.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      cp.on('error', fail);
      load.on('error', fail);
      cp.on('close', (code) => {
        if (code !== 0) fail(new Error(`docker exec cat failed (exit ${code}): ${stderr}`));
      });
      load.on('close', (code) => {
        if (code === 0) succeed();
        else fail(new Error(`docker load failed (exit ${code}): ${stderr}`));
      });
    });
  }
}
