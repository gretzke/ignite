import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptSecret, decryptSecret } from '../../../plugins/vault/crypto.js';

const key = randomBytes(32);

describe('vault crypto', () => {
  it('round-trips a secret', () => {
    const enc = encryptSecret('etherscan-api-key-123', key);
    expect(enc.iv).toBeTruthy();
    expect(enc.ciphertext).toBeTruthy();
    expect(enc.tag).toBeTruthy();
    expect(decryptSecret(enc, key)).toBe('etherscan-api-key-123');
  });

  it('produces a distinct IV/ciphertext each call (random IV)', () => {
    const a = encryptSecret('same', key);
    const b = encryptSecret('same', key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('round-trips empty and unicode', () => {
    expect(decryptSecret(encryptSecret('', key), key)).toBe('');
    const u = '🔐 clé secrète';
    expect(decryptSecret(encryptSecret(u, key), key)).toBe(u);
  });

  it('fails to decrypt with the wrong key', () => {
    const enc = encryptSecret('secret', key);
    expect(() => decryptSecret(enc, randomBytes(32))).toThrow();
  });

  it('fails on a tampered ciphertext (auth tag catches it)', () => {
    const enc = encryptSecret('secret', key);
    const bytes = Buffer.from(enc.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    expect(() =>
      decryptSecret({ ...enc, ciphertext: bytes.toString('base64') }, key)
    ).toThrow();
  });

  it('fails on a tampered tag', () => {
    const enc = encryptSecret('secret', key);
    const tag = Buffer.from(enc.tag, 'base64');
    tag[0] ^= 0xff;
    expect(() => decryptSecret({ ...enc, tag: tag.toString('base64') }, key)).toThrow();
  });

  it('rejects a non-32-byte key', () => {
    expect(() => encryptSecret('x', randomBytes(16))).toThrow(/key/i);
  });
});
