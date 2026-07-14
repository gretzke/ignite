// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import vectors from '../../../../../shared/api/src/__fixtures__/projection-vectors.json';
import { projectWorkflowPlan } from '../projection';

describe('workflow subset projection parity vectors', () => {
  for (const vector of vectors) {
    it(vector.name, () => {
      expect(projectWorkflowPlan(vector.input as never)).toEqual(vector.expectedPlan);
    });
  }
});
