// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { ValidationReport } from '@ignite/api';
import { reviewPredictedAddresses } from '../reviewPredictions';

describe('reviewPredictedAddresses', () => {
  it('marks provisional predicted entries for the ReviewStep marker', () => {
    const report = {
      chains: {
        '1': {
          create2: {
            details: {
              predicted: {
                static: {
                  predictedAddress:
                    '0x0000000000000000000000000000000000000001',
                },
                dynamic: {
                  predictedAddress:
                    '0x0000000000000000000000000000000000000002',
                  provisional: true,
                },
              },
              provisionalSteps: [{ stepId: 'dynamic' }],
            },
          },
        },
      },
    } as unknown as ValidationReport;

    expect(reviewPredictedAddresses(report)).toEqual([
      {
        chainId: '1',
        stepId: 'static',
        address: '0x0000000000000000000000000000000000000001',
        provisional: false,
      },
      {
        chainId: '1',
        stepId: 'dynamic',
        address: '0x0000000000000000000000000000000000000002',
        provisional: true,
      },
    ]);
  });
});
