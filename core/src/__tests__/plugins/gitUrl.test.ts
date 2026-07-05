import { describe, it, expect } from 'vitest';
import {
  convertHttpsToSsh,
  isGitUrl,
  extractBaseHost,
  normalizeRepoUrl,
  parseGitHubUrl,
  isGitHubUrl,
} from '@ignite/plugin-types';

describe('gitUrl helpers', () => {
  it.each([
    ['https://github.com/a/b', 'git@github.com:a/b.git'],
    ['https://github.com/a/b.git', 'git@github.com:a/b.git'],
    ['https://github.com/a/b/', 'git@github.com:a/b.git'],
    ['git@github.com:a/b.git', 'git@github.com:a/b.git'],
    ['/local/path', '/local/path'],
  ])('convertHttpsToSsh(%s) -> %s', (input, expected) => {
    expect(convertHttpsToSsh(input)).toBe(expected);
  });

  it.each([
    ['https://github.com/a/b', true],
    ['git@github.com:a/b.git', true],
    ['ssh://git@github.com/a/b', true],
    ['/Users/x/repo', false],
    ['./relative', false],
  ])('isGitUrl(%s) -> %s', (input, expected) => {
    expect(isGitUrl(input)).toBe(expected);
  });

  it.each([
    ['git@github.com:a/b.git', 'github.com'],
    ['https://gitlab.com/a/b', 'gitlab.com'],
    ['ssh://git@bitbucket.org/a/b', 'bitbucket.org'],
    ['not a url', null],
  ])('extractBaseHost(%s) -> %s', (input, expected) => {
    expect(extractBaseHost(input)).toBe(expected);
  });

  it('normalizeRepoUrl converts SSH to HTTPS and strips .git', () => {
    expect(normalizeRepoUrl('git@github.com:a/b.git')).toBe(
      'https://github.com/a/b'
    );
    expect(normalizeRepoUrl('https://github.com/a/b.git')).toBe(
      'https://github.com/a/b'
    );
  });

  it('parseGitHubUrl extracts owner/name', () => {
    expect(parseGitHubUrl('https://github.com/uniswap/ignite')).toEqual({
      owner: 'uniswap',
      name: 'ignite',
    });
    expect(parseGitHubUrl('https://gitlab.com/a/b')).toBeNull();
    expect(isGitHubUrl('https://github.com/a/b')).toBe(true);
  });
});
