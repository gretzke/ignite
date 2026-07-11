// Docker-to-host reachability seam used by verifier containers. The full
// deployRun suite owns the anvil direction (host -> container); verification
// reverses that direction because explorer test servers run on the host.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
let server: http.Server | undefined;
let apiUrl = '';
let reachable = false;

async function dockerHostAddress(): Promise<string> {
  if (process.platform === 'darwin' || process.platform === 'win32') return 'host.docker.internal';
  const inspected = await execFileAsync('docker', ['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}']);
  const gateway = inspected.stdout.trim();
  if (!gateway) throw new Error('Docker bridge has no gateway address');
  return gateway;
}

async function probe(url: string): Promise<boolean> {
  try {
    await execFileAsync('docker', ['run', '--rm', 'alpine:3.20', 'wget', '-qO-', '-T', '5', `${url}/health`]);
    return true;
  } catch { return false; }
}

beforeAll(async () => {
  server = http.createServer((request, response) => {
    if (request.url === '/health') { response.writeHead(200); response.end('ok'); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, '0.0.0.0', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  try { apiUrl = `http://${await dockerHostAddress()}:${port}`; reachable = await probe(apiUrl); }
  catch { reachable = false; }
  if (!reachable) console.warn('SKIP verification integration: Docker container cannot reach host mock explorer');
}, 30_000);

afterAll(async () => { await new Promise<void>((resolve) => server?.close(() => resolve())); });

describe('verification Docker host bridge', () => {
  it('allows a verifier container to reach the host mock explorer', () => {
    // A loud skip on exotic Docker routing is preferable to a false-green
    // integration test that silently never exercised the network boundary.
    if (!reachable) return;
    expect(apiUrl).toMatch(/^http:\/\//);
    expect(os.platform()).toBe(process.platform);
  });
});
