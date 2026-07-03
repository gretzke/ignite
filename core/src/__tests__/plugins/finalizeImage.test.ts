import { describe, it, expect } from 'vitest';
import { parsePluginMetadata } from '../../plugins/install/finalizeImage.js';

describe('parsePluginMetadata', () => {
  it('parses a bare metadata JSON object', () => {
    const meta = parsePluginMetadata(
      '{"id":"waffle","type":"compiler","name":"W","version":"1.0.0","baseImage":"x"}'
    );
    expect(meta.id).toBe('waffle');
    expect(meta.type).toBe('compiler');
  });

  it('unwraps a { data } envelope (getInfo shape)', () => {
    const meta = parsePluginMetadata(
      'noise\n{"data":{"id":"waffle","type":"compiler","name":"W","version":"1.0.0","baseImage":"x"}}\n'
    );
    expect(meta.id).toBe('waffle');
  });

  it('throws when no JSON object is present', () => {
    expect(() => parsePluginMetadata('no json here')).toThrow(
      /could not read plugin metadata/i
    );
  });

  it('throws when id or type is missing', () => {
    expect(() => parsePluginMetadata('{"id":"waffle"}')).toThrow(
      /missing id\/type/i
    );
  });
});
