// Library-linking uses compiler byte offsets, never offsets in the hex string.
import type { Hex, LinkReferencesWire } from '@ignite/api';
import { IgniteError } from '../types/errors.js';

export function libKey(sourcePath: string, name: string): string {
  return `${sourcePath}:${name}`;
}

export function flattenLinkReferences(refs: LinkReferencesWire): Array<{ key: string; start: number; length: number }> {
  return Object.entries(refs).flatMap(([sourcePath, libraries]) =>
    Object.entries(libraries).flatMap(([name, ranges]) => ranges.map((range) => ({ key: libKey(sourcePath, name), ...range }))),
  );
}

export function validateUnlinkedBytecode(code: string, refs: LinkReferencesWire): void {
  const fail = (message: string) => { throw new IgniteError(message, 'UNLINKED_BYTECODE_INVALID'); };
  if (!code.startsWith('0x') || (code.length - 2) % 2 !== 0) fail('Unlinked creation bytecode must be 0x-prefixed byte data');
  const bytes = (code.length - 2) / 2;
  const covered = new Set<number>();
  for (const range of flattenLinkReferences(refs)) {
    if (range.length !== 20 || range.start + range.length > bytes) fail(`Link reference for ${range.key} must be an in-bounds 20-byte range`);
    for (let offset = range.start; offset < range.start + range.length; offset += 1) {
      if (covered.has(offset)) fail('Library link references overlap');
      covered.add(offset);
    }
  }
  for (let offset = 0; offset < bytes; offset += 1) {
    if (!/^[0-9a-fA-F]{2}$/.test(code.slice(2 + offset * 2, 4 + offset * 2)) && !covered.has(offset)) fail('Non-hex bytecode is outside a library link reference');
  }
}

export function linkBytecode(unlinkedCreationCode: string, refs: LinkReferencesWire, resolved: Record<string, Hex>): Hex {
  validateUnlinkedBytecode(unlinkedCreationCode, refs);
  let linkedCreationCode = unlinkedCreationCode;
  for (const ref of flattenLinkReferences(refs)) {
    const address = resolved[ref.key];
    if (!address) throw new IgniteError(`Library binding is missing for ${ref.key}`, 'LIBRARY_BINDING_MISSING', { key: ref.key });
    const at = 2 + ref.start * 2;
    linkedCreationCode = `${linkedCreationCode.slice(0, at)}${address.slice(2).toLowerCase()}${linkedCreationCode.slice(at + 40)}`;
  }
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(linkedCreationCode)) throw new IgniteError('Library linking did not produce strict hex', 'LINKING_PRODUCED_INVALID_HEX');
  return linkedCreationCode as Hex;
}
