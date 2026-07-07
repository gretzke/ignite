// AES-256-GCM authenticated encryption for vault secrets. Random 12-byte IV
// per value; the 16-byte GCM tag makes tampering (or a wrong key) a decrypt
// failure rather than silent garbage. All fields base64.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedValue {
  iv: string;
  ciphertext: string;
  tag: string;
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`Vault master key must be ${KEY_BYTES} bytes`);
  }
}

export function encryptSecret(plaintext: string, masterKey: Buffer): EncryptedValue {
  assertKey(masterKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: tag.toString('base64'),
  };
}

export function decryptSecret(entry: EncryptedValue, masterKey: Buffer): string {
  assertKey(masterKey);
  const decipher = createDecipheriv(
    ALGORITHM,
    masterKey,
    Buffer.from(entry.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(entry.ciphertext, 'base64')),
    decipher.final(), // throws on auth failure (tamper / wrong key)
  ]);
  return plaintext.toString('utf8');
}
