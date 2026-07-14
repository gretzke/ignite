import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createDeploymentHandlers } from '../../api/deployments.js';
import { IgniteError, ErrorCodes } from '../../types/errors.js';
import {
  initcodeHashOf,
  predictCreate2Address,
} from '../../deployments/create2.js';
import type { Hex } from '@ignite/api';

function reply() {
  const value = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return value as unknown as FastifyReply & typeof value;
}
const request = (body?: unknown, params?: unknown, query?: unknown) =>
  ({ body, params, query }) as FastifyRequest;
const plan = {
  schemaVersion: 1,
  contracts: [
    {
      id: 'c',
      repoPathOrUrl: 'repo',
      frameworkId: 'f',
      artifactPath: 'a',
      contractName: 'C',
      sourcePath: 'C.sol',
    },
  ],
  steps: [{ id: 's', kind: 'deploy', contractId: 'c' }],
  chains: [1],
  signers: {},
} as const;
const check = {
  rpc: { ok: true, blocking: false, message: 'ok' },
  signers: { ok: true, blocking: false, message: 'ok' },
  args: { ok: true, blocking: false, message: 'ok' },
  estimation: { ok: true, blocking: false, message: 'ok' },
  balance: { ok: true, blocking: false, message: 'ok' },
  inputs: { ok: true, blocking: false, message: 'ok' },
};
const run = {
  id: 'r',
  profileId: 'one',
  name: 'run',
  status: 'running',
  lanes: { '1': { status: 'running' } },
};

describe('deployment route handlers', () => {
  const frozen = {
    c: {
      abi: [{ type: 'constructor', inputs: [] }],
      creationBytecode: '0x6000',
      compiler: { pluginId: 'f', version: '1', settingsHash: 'a'.repeat(64) },
      artifactHash: 'a'.repeat(64),
      repoDirty: false,
    },
  };
  const prepareBody = (strategy: unknown) => ({
    contracts: plan.contracts,
    steps: [{ id: 's', kind: 'deploy', contractId: 'c', strategy }],
    stepId: 's',
    chainIds: [1],
  });

  it('prepares a server-built create2 preview', async () => {
    const handlers = createDeploymentHandlers({
      engine: {
        launch: vi.fn(),
        resolveLane: vi.fn(),
        resume: vi.fn(),
        abort: vi.fn(),
      } as never,
      getProfileManager: async () => ({ getCurrentProfile: () => 'one' }),
      freezeInputs: vi.fn(async () => frozen as never),
    });
    const res = reply();
    const salt = `0x${'11'.repeat(32)}` as Hex;
    await handlers.prepareDeploymentStep(
      request(prepareBody({ kind: 'create2', salt })) as never,
      res
    );
    const hash = initcodeHashOf('0x6000' as Hex);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      data: {
        chains: {
          '1': {
            salt,
            initcodeHash: hash,
            predictedAddress: predictCreate2Address(salt, hash),
            notes: [],
          },
        },
      },
    });
  });

  it('uses plugin preparation but rejects plugin-controlled address math', async () => {
    const salt = `0x${'22'.repeat(32)}` as Hex;
    const prepare = vi.fn(async () => ({
      salt,
      predictedAddress: '0x0000000000000000000000000000000000000002' as Hex,
      notes: ['mined'],
    }));
    const handlers = createDeploymentHandlers({
      engine: {
        launch: vi.fn(),
        resolveLane: vi.fn(),
        resume: vi.fn(),
        abort: vi.fn(),
      } as never,
      getProfileManager: async () => ({ getCurrentProfile: () => 'one' }),
      freezeInputs: vi.fn(async () => frozen as never),
      deploymentTypes: { prepare },
    });
    const res = reply();
    await handlers.prepareDeploymentStep(
      request(prepareBody({ kind: 'plugin', pluginId: 'hook' })) as never,
      res
    );
    expect(res.statusCode).toBe(500);
    expect((res.body as { code: string }).code).toBe(
      ErrorCodes.PLUGIN_PREPARE_MISMATCH
    );
  });

  it('returns a plugin prepare result when the core address computation agrees', async () => {
    const salt = `0x${'33'.repeat(32)}` as Hex;
    const hash = initcodeHashOf('0x6000' as Hex);
    const handlers = createDeploymentHandlers({
      engine: {
        launch: vi.fn(),
        resolveLane: vi.fn(),
        resume: vi.fn(),
        abort: vi.fn(),
      } as never,
      getProfileManager: async () => ({ getCurrentProfile: () => 'one' }),
      freezeInputs: vi.fn(async () => frozen as never),
      deploymentTypes: {
        prepare: vi.fn(async () => ({
          salt,
          predictedAddress: predictCreate2Address(salt, hash),
          notes: ['mined'],
        })),
      },
    });
    const res = reply();
    await handlers.prepareDeploymentStep(
      request(prepareBody({ kind: 'plugin', pluginId: 'hook' })) as never,
      res
    );
    expect(res.statusCode).toBe(200);
    expect(
      (res.body as { data: { chains: { '1': { notes: string[] } } } }).data
        .chains['1'].notes
    ).toEqual(['mined']);
  });

  it('forwards linked runtime bytecode to deployment-type preparation', async () => {
    const salt = `0x${'34'.repeat(32)}` as Hex;
    const prepare = vi.fn(async () => ({ salt, predictedAddress: predictCreate2Address(salt, initcodeHashOf('0x6000' as Hex)), notes: [] }));
    const handlers = createDeploymentHandlers({
      engine: { launch: vi.fn(), resolveLane: vi.fn(), resume: vi.fn(), abort: vi.fn() } as never,
      getProfileManager: async () => ({ getCurrentProfile: () => 'one' }),
      freezeInputs: vi.fn(async () => ({ c: { ...frozen.c, runtimeBytecode: `0x60${'zz'.repeat(20)}00`, runtimeBytecodeLinkReferences: { 'src/R.sol': { R: [{ start: 1, length: 20 }] } } } }) as never),
      deploymentTypes: { prepare },
    });
    await handlers.prepareDeploymentStep(request({
      ...prepareBody({ kind: 'plugin', pluginId: 'hook' }),
      steps: [{ id: 's', kind: 'deploy', contractId: 'c', libraries: { 'src/R.sol:R': { kind: 'address', address: '0x0000000000000000000000000000000000000002' } }, strategy: { kind: 'plugin', pluginId: 'hook' } }],
    }) as never, reply());
    expect(prepare).toHaveBeenCalledWith('hook', expect.objectContaining({ runtimeBytecode: `0x60${'0000000000000000000000000000000000000002'}00` }));
  });

  it('rejects a prepare input that depends on a plain-create address', async () => {
    const handlers = createDeploymentHandlers({
      engine: {
        launch: vi.fn(),
        resolveLane: vi.fn(),
        resume: vi.fn(),
        abort: vi.fn(),
      } as never,
      getProfileManager: async () => ({ getCurrentProfile: () => 'one' }),
      freezeInputs: vi.fn(async () => frozen as never),
    });
    const res = reply();
    await handlers.prepareDeploymentStep(
      request({
        contracts: plan.contracts,
        steps: [
          { id: 'plain', kind: 'deploy', contractId: 'c' },
          {
            id: 's',
            kind: 'deploy',
            contractId: 'c',
            args: { peer: { $ref: { kind: 'step', stepId: 'plain' } } },
            strategy: { kind: 'create2', salt: `0x${'44'.repeat(32)}` },
          },
        ],
        stepId: 's',
        chainIds: [1],
      }) as never,
      res
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { code: string }).code).toBe('POINTER_NOT_CONCRETE');
  });

  it('validates without launching or writing a run', async () => {
    const launch = vi.fn();
    const validate = vi.fn(async () => ({
      report: { chains: { '1': check } },
      frozen: {},
    }));
    const handlers = createDeploymentHandlers({
      engine: {
        launch,
        resolveLane: vi.fn(),
        resume: vi.fn(),
        abort: vi.fn(),
      } as never,
      validate,
      getProfileManager: async () => ({ getCurrentProfile: () => 'one' }),
    });
    const res = reply();
    await handlers.validateDeployment(
      request({ plan, rpcSelection: { '1': 'rpc' } }) as never,
      res
    );
    expect(res.statusCode).toBe(200);
    expect(launch).not.toHaveBeenCalled();
    expect(validate).toHaveBeenCalledOnce();
  });

  it('passes profile scope and returns the engine idempotent launch result', async () => {
    const launch = vi.fn(async () => run);
    const profile = {
      current: 'one',
      getCurrentProfile() {
        return this.current;
      },
    };
    const handlers = createDeploymentHandlers({
      engine: {
        launch,
        resolveLane: vi.fn(),
        resume: vi.fn(),
        abort: vi.fn(),
      } as never,
      getProfileManager: async () => profile,
    });
    const body = { plan, rpcSelection: { '1': 'rpc' }, idempotencyKey: 'k' };
    const first = reply();
    const second = reply();
    await handlers.createDeploymentRun(request(body) as never, first);
    await handlers.createDeploymentRun(request(body) as never, second);
    expect(launch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ profileId: 'one', idempotencyKey: 'k' })
    );
    expect(first.body).toEqual(second.body);
    profile.current = 'two';
    const listRuns = vi.fn(async (id: string) => ({
      runs: [
        {
          id: 'r',
          profileId: id,
          name: 'run',
          createdAt: 't',
          updatedAt: 't',
          status: 'running' as const,
          chains: [1],
        },
      ],
      unreadable: [],
    }));
    const scoped = createDeploymentHandlers({
      engine: {
        launch,
        resolveLane: vi.fn(),
        resume: vi.fn(),
        abort: vi.fn(),
      } as never,
      listRuns,
      getProfileManager: async () => profile,
    });
    await scoped.listDeploymentRuns(
      request(undefined, undefined, {}) as never,
      reply()
    );
    expect(listRuns).toHaveBeenCalledWith('two');
  });

  it('maps stale resolution to 409 and abort returns the persisted immediate state', async () => {
    const engine = {
      launch: vi.fn(),
      resolveLane: vi.fn(async () => {
        throw new IgniteError('stale', ErrorCodes.STALE_RESOLVE);
      }),
      resume: vi.fn(),
      abort: vi.fn(async () => ({
        ...run,
        abortRequested: true,
        status: 'aborted',
      })),
    };
    const handlers = createDeploymentHandlers({
      engine: engine as never,
      getProfileManager: async () => ({ getCurrentProfile: () => 'one' }),
    });
    const conflict = reply();
    await handlers.resolveDeploymentLane(
      request(
        { action: 'retry', attemptId: 'a', commandId: 'c' },
        { runId: 'r', chainId: '1' }
      ) as never,
      conflict
    );
    expect(conflict.statusCode).toBe(409);
    const aborted = reply();
    await handlers.abortDeploymentRun(
      request(undefined, { runId: 'r' }) as never,
      aborted
    );
    expect(
      (aborted.body as { data: { run: { abortRequested: boolean } } }).data.run
        .abortRequested
    ).toBe(true);
  });

  it('returns artifact 404 until a lane is terminal', async () => {
    const handlers = createDeploymentHandlers({
      engine: {
        launch: vi.fn(),
        resolveLane: vi.fn(),
        resume: vi.fn(),
        abort: vi.fn(),
      } as never,
      getProfileManager: async () => ({ getCurrentProfile: () => 'one' }),
      getRun: async () => run as never,
    });
    const res = reply();
    await handlers.getDeploymentArtifact(
      request(undefined, { runId: 'r' }) as never,
      res
    );
    expect(res.statusCode).toBe(404);
  });
});
