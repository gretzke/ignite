// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import {
  decodeUrlEncodingForDisplay,
  replaceIdsForDisplay,
} from '../displayText';

describe('wizard display text', () => {
  const stepId =
    'deploy-%2FUsers%2Fdaniel%2Fcontracts:foundry:foundry-out%2FWETHHook.sol%2FWETHHook.json:WETHHook';

  it('decodes URL-escaped paths without changing internal ids', () => {
    expect(decodeUrlEncodingForDisplay(stepId)).toBe(
      'deploy-/Users/daniel/contracts:foundry:foundry-out/WETHHook.sol/WETHHook.json:WETHHook'
    );
  });

  it('uses a friendly step label when one is available', () => {
    expect(
      replaceIdsForDisplay(`Simulation reverted at ${stepId}`, {
        [stepId]: 'WETHHook',
      })
    ).toBe('Simulation reverted at WETHHook');
  });

  it('leaves malformed URI escapes intact', () => {
    expect(decodeUrlEncodingForDisplay('deploy-%2Frepo-%ZZ')).toBe(
      'deploy-%2Frepo-%ZZ'
    );
  });
});
