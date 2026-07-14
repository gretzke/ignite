import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { createPointerSuggestionHandlers } from '../../api/pointerSuggestions.js';
import { PointerSuggestionRequestSchema, PointerSuggestionResponseSchema } from '@ignite/api';

function reply() {
  const value = { statusCode: 0, body: undefined as unknown, status(code: number) { this.statusCode = code; return this; }, send(body: unknown) { this.body = body; return this; } };
  return value as FastifyReply & typeof value;
}

describe('pointer suggestion API', () => {
  it('returns the grouped/truncated service response for the active profile', async () => {
    const suggest = vi.fn(async () => ({ suggestionsByChain: { '1': [] }, truncated: true }));
    const res = reply();
    await createPointerSuggestionHandlers({ suggest }, async () => 'profile-1').pointerSuggestions({ body: { contractName: 'Token', chainIds: [1] } } as never, res);
    expect(suggest).toHaveBeenCalledWith({ contractName: 'Token', chainIds: [1] }, 'profile-1');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ data: { suggestionsByChain: { '1': [] }, truncated: true } });
  });

  it('pins the strict source/hash request and grouped response wire', () => {
    expect(PointerSuggestionRequestSchema.parse({ workflow: { repoPathOrUrl: '/repo', name: 'release' }, sourceId: 'token', expectedArtifactHash: 'a'.repeat(64), contractName: 'Token', chainIds: [1] })).toMatchObject({ sourceId: 'token' });
    expect(() => PointerSuggestionRequestSchema.parse({ sourceId: 'token', contractName: 'Token', chainIds: [1] })).toThrow();
    expect(PointerSuggestionResponseSchema.parse({ data: { suggestionsByChain: { '1': [] }, truncated: false } })).toEqual({ data: { suggestionsByChain: { '1': [] }, truncated: false } });
  });
});
