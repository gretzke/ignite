// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { pointerPauseEditTarget } from '../pointerPauseEditTarget';

describe('pointerPauseEditTarget', () => {
  it('maps direct canonical paths without turning them into literal argument keys', () => {
    expect(pointerPauseEditTarget({ stepId: 'call-1', path: 'args.owner' }, 'call-1')).toEqual({ section: 'args', field: 'owner' });
    expect(pointerPauseEditTarget({ stepId: 'call-1', path: 'target' }, 'call-1')).toEqual({ section: 'target' });
    expect(pointerPauseEditTarget({ stepId: 'deploy-1', path: 'libraries.src/MathLib.sol:MathLib' }, 'deploy-1')).toEqual({ section: 'libraries', key: 'src/MathLib.sol:MathLib' });
  });

  it('opens arguments without a prefill for nested tuple and array paths', () => {
    expect(pointerPauseEditTarget({ stepId: 'call-1', path: 'args.config.owner' }, 'call-1')).toEqual({ section: 'args' });
    expect(pointerPauseEditTarget({ stepId: 'call-1', path: 'args.recipients[0]' }, 'call-1')).toEqual({ section: 'args' });
    expect(pointerPauseEditTarget({ stepId: 'other', path: 'args.owner' }, 'call-1')).toBeUndefined();
  });
});
