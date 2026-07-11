// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { constructorInputs } from '../../../components/ConstructorArgsForm';
import { verificationSubmitBody } from '../VerifyContractPage';

const contract = {
  id: 'token', repoPathOrUrl: '/repo', frameworkId: 'foundry',
  artifactPath: 'out/Token.json', contractName: 'Token', sourcePath: 'src/Token.sol',
};

describe('VerifyContractPage helpers', () => {
  it('submits constructor values XOR an encoded guessed tail', () => {
    const manual = verificationSubmitBody({ contract, chainId: 1, address: '0x0000000000000000000000000000000000000001', args: { owner: '0x1' }, explorerEntryIds: ['scan'] });
    expect(manual).toHaveProperty('args');
    expect(manual).not.toHaveProperty('encodedConstructorArgs');
    const guessed = verificationSubmitBody({ contract, chainId: 1, address: '0x0000000000000000000000000000000000000001', args: {}, encodedConstructorArgs: '0x1234', explorerEntryIds: ['scan'] });
    expect(guessed).toHaveProperty('encodedConstructorArgs', '0x1234');
    expect(guessed).not.toHaveProperty('args');
  });

  it('skips the argument section for a zero-input constructor', () => {
    expect(constructorInputs([{ type: 'constructor', inputs: [] }])).toEqual([]);
  });
});
