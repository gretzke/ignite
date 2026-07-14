import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { createWorkflowPromotionHandlers } from '../../api/workflowPromotion.js';
import { WorkflowPromoteRequestSchema, WorkflowCheckUpdatesRequestSchema } from '@ignite/api';

function reply() { const value = { statusCode: 0, body: undefined as unknown, status(code: number) { this.statusCode = code; return this; }, send(body: unknown) { this.body = body; return this; } }; return value as FastifyReply & typeof value; }

describe('workflow promotion/update API', () => {
  it('routes preview/apply and update checks through the active profile', async () => {
    const promote = vi.fn(async () => ({ mode: 'preview' as const, previewId: 'preview', nameCollision: false, sources: [] }));
    const check = vi.fn(async () => ({ sources: [], plugins: [] }));
    const handlers = createWorkflowPromotionHandlers({ promote } as never, { check } as never, async () => 'p1');
    const promoteReply = reply(); await handlers.promoteWorkflow({ body: { mode: 'preview' } } as never, promoteReply);
    expect(promote).toHaveBeenCalledWith({ mode: 'preview' }, 'p1'); expect(promoteReply.statusCode).toBe(200);
    const updateReply = reply(); await handlers.checkWorkflowUpdates({ body: { repoPathOrUrl: '/repo', name: 'release' } } as never, updateReply);
    expect(check).toHaveBeenCalledWith({ repoPathOrUrl: '/repo', name: 'release' }); expect(updateReply.statusCode).toBe(200);
  });

  it('pins the discriminated two-phase request and strict update wire', () => {
    const target = { repoPathOrUrl: '/repo', name: 'release' };
    expect(() => WorkflowPromoteRequestSchema.parse({ mode: 'apply', target, hooks: [] })).toThrow();
    expect(WorkflowCheckUpdatesRequestSchema.parse({ repoPathOrUrl: '/repo', name: 'release' })).toEqual({ repoPathOrUrl: '/repo', name: 'release' });
  });
});
