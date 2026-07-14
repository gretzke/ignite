// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { PointerSuggestion } from '@ignite/api';
import { manualResolution, suggestionResolution } from '../UnboundSlotPicker';

describe('UnboundSlotPicker confirmations', () => {
  it('records suggestion provenance from the selected candidate', () => {
    const suggestion: PointerSuggestion = { address: '0x1111111111111111111111111111111111111111', match: 'artifact-hash', versionLabel: 'v1', sources: [{ kind: 'artifact', runId: 'run-1', at: 'now' }] };
    expect(suggestionResolution('call', '/target', 1, suggestion)).toEqual({ stepId: 'call', path: '/target', chainId: 1, address: suggestion.address, source: 'suggestion', via: { kind: 'artifact', runId: 'run-1' } });
  });

  it('accepts only validated manual addresses', () => {
    expect(manualResolution('call', '/target', 1, 'not-an-address')).toBeUndefined();
    expect(manualResolution('call', '/target', 1, '0x2222222222222222222222222222222222222222')).toMatchObject({ source: 'manual', address: '0x2222222222222222222222222222222222222222' });
  });
});
