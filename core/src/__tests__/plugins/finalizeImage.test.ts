import { describe, it, expect } from 'vitest';
import { RESULT_BEGIN, RESULT_END } from '@ignite/plugin-types';
import { parsePluginMetadata } from '../../plugins/install/finalizeImage.js';

const wrap = (json: string): string => `${RESULT_BEGIN}${json}${RESULT_END}`;

describe('parsePluginMetadata', () => {
  it('parses a sentinel-framed bare metadata object', () => {
    const meta = parsePluginMetadata(
      wrap(
        '{"id":"waffle","type":"compiler","name":"W","version":"1.0.0","baseImage":"x"}'
      )
    );
    expect(meta.id).toBe('waffle');
    expect(meta.types).toEqual(['compiler']);
  });

  it('unwraps a { data } envelope (getInfo shape), ignoring surrounding noise', () => {
    const meta = parsePluginMetadata(
      `noise\n${wrap(
        '{"data":{"id":"waffle","type":"compiler","name":"W","version":"1.0.0","baseImage":"x"}}'
      )}\n`
    );
    expect(meta.id).toBe('waffle');
  });

  it('throws for un-framed output (no legacy bare-JSON fallback)', () => {
    expect(() =>
      parsePluginMetadata(
        '{"id":"waffle","type":"compiler","name":"W","version":"1.0.0","baseImage":"x"}'
      )
    ).toThrow(/could not read plugin metadata/i);
  });

  it('throws when no JSON object is present', () => {
    expect(() => parsePluginMetadata('no json here')).toThrow(
      /could not read plugin metadata/i
    );
  });

  it('throws when id or types are missing', () => {
    expect(() => parsePluginMetadata(wrap('{"id":"waffle"}'))).toThrow(
      /missing id\/types/i
    );
  });

  it('surfaces the plugin error when getInfo reports success:false', () => {
    expect(() =>
      parsePluginMetadata(
        wrap('{"success":false,"error":{"code":"BOOM","message":"exploded"}}')
      )
    ).toThrow(/getInfo reported an error: exploded/);
  });

  it('prefers a sentinel-framed envelope over stray braces in the log', () => {
    const framed =
      'npm warn config {"not":"the result"}\n' +
      `${RESULT_BEGIN}{"success":true,"data":{"id":"stub","type":"compiler","name":"Stub","version":"1.2.3","baseImage":"unused"}}${RESULT_END}\n`;
    const meta = parsePluginMetadata(framed);
    expect(meta.id).toBe('stub');
    expect(meta.version).toBe('1.2.3');
  });
});
