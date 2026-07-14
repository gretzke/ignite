import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { createDeploymentHookHandlers } from '../../api/deploymentHooks.js';

function reply() {
  const value = { statusCode: 0, body: undefined as unknown, status(code: number) { this.statusCode = code; return this; }, send(body: unknown) { this.body = body; return this; } };
  return value as FastifyReply & typeof value;
}

describe('deployment hook API', () => {
  it('lists the cached deployment-hook descriptions', async () => {
    const list = vi.fn(async () => [{ pluginId: 'chronicles', label: 'Chronicles', description: 'Writes history' }]);
    const res = reply();
    await createDeploymentHookHandlers({ list }).listDeploymentHooks({} as never, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ data: { deploymentHooks: [{ pluginId: 'chronicles', label: 'Chronicles', description: 'Writes history' }] } });
  });
});
