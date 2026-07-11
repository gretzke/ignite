import { describe, expect, it } from 'vitest';
import { summaryFromStandardJson } from '../../deployments/ArtifactFreezeService.js';

describe('summaryFromStandardJson', () => {
  it('derives the summary from the bundle settings, never fabricating', () => {
    expect(
      summaryFromStandardJson('foundry', {
        settings: {
          optimizer: { enabled: true, runs: 777 },
          viaIR: true,
          evmVersion: 'cancun',
        },
      })
    ).toEqual({
      pluginId: 'foundry',
      evmVersion: 'cancun',
      optimizer: true,
      runs: 777,
      viaIR: true,
    });
  });
  it('defaults conservatively when settings are absent', () => {
    expect(summaryFromStandardJson('hardhat', {})).toEqual({
      pluginId: 'hardhat',
      optimizer: false,
      runs: 0,
      viaIR: false,
    });
  });
});
