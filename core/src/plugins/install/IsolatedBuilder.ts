import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { getLogger } from '../../utils/logger.js';

// Squid egress ACL: deny loopback + RFC1918 + link-local BEFORE allowing the
// rest of the internet (squid evaluates rules top-to-bottom). host.docker.internal
// resolves inside 192.168.0.0/16 on Docker Desktop, so the generic RFC1918 rule
// covers it. This is the policy layer; the --internal network is the enforcement
// layer (a build ignoring the proxy env has no route out at all).
export const SQUID_CONF = `acl SSL_ports port 443
acl CONNECT method CONNECT
acl private_dst dst 127.0.0.0/8
acl private_dst dst 10.0.0.0/8
acl private_dst dst 172.16.0.0/12
acl private_dst dst 192.168.0.0/16
acl private_dst dst 169.254.0.0/16
http_access deny private_dst
http_access allow CONNECT SSL_ports
http_access allow all
http_port 3128
`;

const BUILDKIT_IMAGE = 'moby/buildkit:rootless';
const SQUID_IMAGE = 'ubuntu/squid:latest';
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

// Run a docker CLI command, capturing stdout; reject on non-zero exit.
function dockerCli(args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`docker ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(
            `docker ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`
          )
        );
    });
  });
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
    const proxyUrl = `http://${proxy}:3128`;

    getLogger().info(`🔒 Starting isolated build ${id} from ${contextDir}`);

    try {
      // 1. Networks: internal (no route out) + egress (normal bridge).
      await dockerCli(['network', 'create', '--internal', internalNet]);
      await dockerCli(['network', 'create', egressNet]);

      // 2. Egress proxy: start on the internal net, write its config, then
      //    dual-home it onto the egress net (the ONLY container with a route out).
      await dockerCli([
        'run',
        '-d',
        '--name',
        proxy,
        '--network',
        internalNet,
        SQUID_IMAGE,
      ]);
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
      await this.assertUnprivileged(builder);
      await this.waitForBuildkitReady(builder);

      // 4. Copy source into the builder and build to a docker-format tarball.
      await dockerCli(['exec', builder, 'mkdir', '-p', '/tmp/src']);
      await dockerCli(['cp', `${contextDir}/.`, `${builder}:/tmp/src`]);

      const dfDir = dockerfileRel.includes('/')
        ? `/tmp/src/${dockerfileRel.slice(0, dockerfileRel.lastIndexOf('/'))}`
        : '/tmp/src';
      const dfName = dockerfileRel.slice(dockerfileRel.lastIndexOf('/') + 1);

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
        await dockerCli(['rm', '-f', c]).catch((err) => {
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

  // Fail closed if the builder somehow came up privileged or with the socket.
  private async assertUnprivileged(container: string): Promise<void> {
    const out = await dockerCli([
      'inspect',
      '--format',
      '{{.HostConfig.Privileged}}|{{range .Mounts}}{{.Source}},{{end}}',
      container,
    ]);
    const [priv, mounts = ''] = out.trim().split('|');
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
  }

  // Poll until squid inside the container will accept an exec (i.e. its
  // process is up), so the config write + reconfigure below don't race
  // container startup.
  private async waitForSquidReady(
    container: string,
    attempts = 20,
    delayMs = 250
  ): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await dockerCli(['exec', container, 'test', '-d', '/etc/squid']);
        return;
      } catch {
        await sleep(delayMs);
      }
    }
    // Not fatal — fall through and let the caller's own retry/restart logic
    // handle it; this is just to avoid the common-case race.
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
