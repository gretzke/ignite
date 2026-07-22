// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import {
  canonicalGitUrl,
  canonicalJson,
  sanitizeDisplayText,
} from '@ignite/api';

describe('shared workflow display utilities', () => {
  it.each([
    ['plain ASCII', 'workflow name', 256, 'workflow name'],
    ['C0 and C1 controls', 'a\u0000b\u001fc\u007fd\u009fe', 256, 'abcde'],
    ['bidi controls', 'a\u202eb\u2066c\u2069d', 256, 'abcd'],
    ['cap uses ellipsis', 'abcdef', 4, 'abc\u2026'],
  ])(
    '%s',
    (_label: string, input: string, maxLen: number, expected: string) => {
      expect(sanitizeDisplayText(input, maxLen)).toBe(expected);
    }
  );

  it('canonicalizes object keys recursively without changing array order', () => {
    expect(canonicalJson({ z: { b: 2, a: 1 }, a: [{ y: 2, x: 1 }] })).toBe(
      '{"a":[{"x":1,"y":2}],"z":{"a":1,"b":2}}'
    );
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it.each([
    ['https://example.test/team/repo.git', 'https://example.test/team/repo'],
    ['https://example.test/team/repo.GIT/', 'https://example.test/team/repo'],
    ['git@github.com:team/repo.git', 'ssh://git@github.com/team/repo'],
    [
      'ssh://git@example.test/team/repo.git',
      'ssh://git@example.test/team/repo',
    ],
  ])('canonicalizes %s', (input: string, expected: string) => {
    expect(canonicalGitUrl(input)).toBe(expected);
  });
});
