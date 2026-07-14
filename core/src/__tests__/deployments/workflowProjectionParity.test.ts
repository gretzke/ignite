import { describe, expect, it } from 'vitest';
import vectors from '../../../../shared/api/src/__fixtures__/projection-vectors.json' with { type: 'json' };
import { validateExternalResolutions } from '../../api/deployments.js';

describe('workflow projection server cross-check parity', () => {
  for (const vector of vectors) {
    it(vector.name, () => {
      expect(() => validateExternalResolutions(vector.expectedPlan as never, vector.input.resolutions as never)).not.toThrow();
      if (vector.input.resolutions.length === 0) return;
      const stale = structuredClone(vector.input.resolutions);
      stale[0].address = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
      expect(() => validateExternalResolutions(vector.expectedPlan as never, stale as never)).toThrow(/does not match/);
    });
  }
});
