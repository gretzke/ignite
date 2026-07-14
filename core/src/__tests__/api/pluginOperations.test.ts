import { describe, expect, it, vi } from 'vitest';
import { PluginType } from '@ignite/plugin-types/types';
import type { FastifyReply } from 'fastify';
import type { PluginMetadata } from '@ignite/plugin-types/types';
import { createPluginOperationHandlers } from '../../api/plugins/operations.js';

const metadata: PluginMetadata = {
  id: 'example',
  types: [PluginType.DEPLOYMENT_TYPE],
  name: 'Example',
  version: '1.0.0',
  baseImage: 'ignite/example:latest',
  operations: ['customOperation', 'describeDeploymentType'],
};

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
  return value as FastifyReply & typeof value;
}

describe('generic plugin operation dispatch', () => {
  it('passes an explicit none chain scope when chainId is absent', async () => {
    const execute = vi.fn(async () => ({ success: true as const, data: 'ok' }));
    const handlers = createPluginOperationHandlers({
      getPluginConfig: vi.fn(async () => ({ metadata, repoRead: false, origin: 'installed' as const })),
      execute,
    });
    const res = reply();
    await handlers.invokePluginOperation(
      { params: { pluginId: metadata.id, operation: 'customOperation' }, body: { options: {} } } as never,
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledWith(metadata.id, 'customOperation', {}, {
      chainScope: 'none',
    });
  });

  it.each([
    ['missing', 'customOperation', 404, 'PLUGIN_NOT_FOUND'],
    ['example', 'notDeclared', 400, 'OPERATION_NOT_DECLARED'],
    ['example', 'compile', 400, 'OPERATION_NOT_DECLARED'],
  ])('rejects %s.%s as required', async (pluginId, operation, status, code) => {
    const handlers = createPluginOperationHandlers({
      getPluginConfig: vi.fn(async (id) => {
        if (id === 'missing') throw new Error('missing');
        return { metadata, repoRead: false, origin: 'installed' as const };
      }),
      execute: vi.fn(),
    });
    const res = reply();
    await handlers.invokePluginOperation(
      { params: { pluginId, operation }, body: {} } as never,
      res,
    );
    expect(res.statusCode).toBe(status);
    expect(res.body).toMatchObject({ code });
  });

  it('rejects declared reserved operations and the reserved config key', async () => {
    const handlers = createPluginOperationHandlers({
      getPluginConfig: vi.fn(async () => ({
        metadata: { ...metadata, operations: ['compile', 'customOperation'] },
        repoRead: false,
        origin: 'installed' as const,
      })),
      execute: vi.fn(),
    });
    const reserved = reply();
    await handlers.invokePluginOperation(
      { params: { pluginId: 'example', operation: 'compile' }, body: {} } as never,
      reserved,
    );
    expect(reserved.body).toMatchObject({ code: 'OPERATION_RESERVED' });

    const config = reply();
    await handlers.invokePluginOperation(
      { params: { pluginId: 'example', operation: 'customOperation' }, body: { options: { config: {} } } } as never,
      config,
    );
    expect(config.body).toMatchObject({ code: 'RESERVED_OPTION_KEY' });
  });

  it.each(['onRunCompleted', 'suggestAddresses'])('reserves deployment-hook operation %s while leaving describe generic-callable', async (operation) => {
    const hookMetadata = { ...metadata, types: [PluginType.DEPLOYMENT_HOOK], operations: ['describeDeploymentHook', 'onRunCompleted', 'suggestAddresses'] };
    const execute = vi.fn(async () => ({ success: true as const, data: {} }));
    const handlers = createPluginOperationHandlers({
      getPluginConfig: vi.fn(async () => ({ metadata: hookMetadata, repoRead: false, origin: 'installed' as const })),
      execute,
    });
    const blocked = reply();
    await handlers.invokePluginOperation({ params: { pluginId: 'example', operation }, body: {} } as never, blocked);
    expect(blocked.body).toMatchObject({ code: 'OPERATION_RESERVED' });

    const described = reply();
    await handlers.invokePluginOperation({ params: { pluginId: 'example', operation: 'describeDeploymentHook' }, body: {} } as never, described);
    expect(described.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledWith('example', 'describeDeploymentHook', {}, { chainScope: 'none' });
  });
});
