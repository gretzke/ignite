import { describe, expect, it } from 'vitest';
import { flattenLinkReferences, linkBytecode, validateUnlinkedBytecode } from '../../deployments/linking.js';

const refs = { 'src/Math.sol': { Math: [{ start: 1, length: 20 }] } };
const placeholder = `0x60${'__$aaf3aaf3aaf3aaf3aaf3aaf3aaf3aaf3aa$__'}00`;
const address = '0x1234567890abcdef1234567890abcdef12345678' as const;

describe('library linking', () => {
  it('links compiler placeholder byte ranges at byte offsets', () => {
    expect(flattenLinkReferences(refs)).toEqual([{ key: 'src/Math.sol:Math', start: 1, length: 20 }]);
    expect(linkBytecode(placeholder, refs, { 'src/Math.sol:Math': address })).toBe(`0x60${address.slice(2)}00`);
  });
  it('rejects invalid containment and names missing bindings', () => {
    expect(() => validateUnlinkedBytecode('0xzz', {})).toThrow(/outside/);
    expect(() => validateUnlinkedBytecode(placeholder, { 'src/Math.sol': { Math: [{ start: 1, length: 19 }] } })).toThrow(/20-byte/);
    try { linkBytecode(placeholder, refs, {}); throw new Error('expected failure'); }
    catch (error) { expect(error).toMatchObject({ code: 'LIBRARY_BINDING_MISSING' }); }
  });
});
