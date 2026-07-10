import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createDeploymentHandlers } from '../../api/deployments.js';
import { IgniteError, ErrorCodes } from '../../types/errors.js';

function reply() {
  const value = { statusCode: 0, body: undefined as unknown, status(code: number) { this.statusCode = code; return this; }, send(body: unknown) { this.body = body; return this; } };
  return value as unknown as FastifyReply & typeof value;
}
const request = (body?: unknown, params?: unknown, query?: unknown) => ({ body, params, query }) as FastifyRequest;
const plan = { schemaVersion: 1, contracts: [{ id: 'c', repoPathOrUrl: 'repo', frameworkId: 'f', artifactPath: 'a', contractName: 'C', sourcePath: 'C.sol' }], steps: [{ id: 's', kind: 'deploy', contractId: 'c' }], chains: [1], signers: {} } as const;
const check = { rpc: { ok: true, blocking: false, message: 'ok' }, signers: { ok: true, blocking: false, message: 'ok' }, args: { ok: true, blocking: false, message: 'ok' }, estimation: { ok: true, blocking: false, message: 'ok' }, balance: { ok: true, blocking: false, message: 'ok' }, inputs: { ok: true, blocking: false, message: 'ok' } };
const run = { id: 'r', profileId: 'one', name: 'run', status: 'running', lanes: { '1': { status: 'running' } } };

describe('deployment route handlers', () => {
  it('validates without launching or writing a run', async () => {
    const launch = vi.fn(); const validate = vi.fn(async () => ({ report: { chains: { '1': check } }, frozen: {} }));
    const handlers = createDeploymentHandlers({ engine: { launch, resolveLane: vi.fn(), resume: vi.fn(), abort: vi.fn() } as never, validate, getProfileManager: async () => ({ getCurrentProfile: () => 'one' }) });
    const res = reply(); await handlers.validateDeployment(request({ plan, rpcSelection: { '1': 'rpc' } }) as never, res);
    expect(res.statusCode).toBe(200); expect(launch).not.toHaveBeenCalled(); expect(validate).toHaveBeenCalledOnce();
  });

  it('passes profile scope and returns the engine idempotent launch result', async () => {
    const launch = vi.fn(async () => run); const profile = { current: 'one', getCurrentProfile() { return this.current; } };
    const handlers = createDeploymentHandlers({ engine: { launch, resolveLane: vi.fn(), resume: vi.fn(), abort: vi.fn() } as never, getProfileManager: async () => profile });
    const body = { plan, rpcSelection: { '1': 'rpc' }, idempotencyKey: 'k' };
    const first = reply(); const second = reply(); await handlers.createDeploymentRun(request(body) as never, first); await handlers.createDeploymentRun(request(body) as never, second);
    expect(launch).toHaveBeenNthCalledWith(1, expect.objectContaining({ profileId: 'one', idempotencyKey: 'k' })); expect(first.body).toEqual(second.body);
    profile.current = 'two'; const listRuns = vi.fn(async (id: string) => ({ runs: [{ id: 'r', profileId: id, name: 'run', createdAt: 't', updatedAt: 't', status: 'running' as const, chains: [1] }], unreadable: [] }));
    const scoped = createDeploymentHandlers({ engine: { launch, resolveLane: vi.fn(), resume: vi.fn(), abort: vi.fn() } as never, listRuns, getProfileManager: async () => profile });
    await scoped.listDeploymentRuns(request(undefined, undefined, {}) as never, reply()); expect(listRuns).toHaveBeenCalledWith('two');
  });

  it('maps stale resolution to 409 and abort returns the persisted immediate state', async () => {
    const engine = { launch: vi.fn(), resolveLane: vi.fn(async () => { throw new IgniteError('stale', ErrorCodes.STALE_RESOLVE); }), resume: vi.fn(), abort: vi.fn(async () => ({ ...run, abortRequested: true, status: 'aborted' })) };
    const handlers = createDeploymentHandlers({ engine: engine as never, getProfileManager: async () => ({ getCurrentProfile: () => 'one' }) });
    const conflict = reply(); await handlers.resolveDeploymentLane(request({ action: 'retry', attemptId: 'a', commandId: 'c' }, { runId: 'r', chainId: '1' }) as never, conflict);
    expect(conflict.statusCode).toBe(409);
    const aborted = reply(); await handlers.abortDeploymentRun(request(undefined, { runId: 'r' }) as never, aborted);
    expect((aborted.body as { data: { run: { abortRequested: boolean } } }).data.run.abortRequested).toBe(true);
  });

  it('returns artifact 404 until a lane is terminal', async () => {
    const handlers = createDeploymentHandlers({ engine: { launch: vi.fn(), resolveLane: vi.fn(), resume: vi.fn(), abort: vi.fn() } as never, getProfileManager: async () => ({ getCurrentProfile: () => 'one' }), getRun: async () => run });
    const res = reply(); await handlers.getDeploymentArtifact(request(undefined, { runId: 'r' }) as never, res);
    expect(res.statusCode).toBe(404);
  });
});
