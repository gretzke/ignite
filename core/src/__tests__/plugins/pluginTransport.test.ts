import { describe, it, expect } from 'vitest';
import {
  createDockerStreamDemuxer,
  parsePluginOutput,
} from '../../plugins/utils/pluginTransport.js';
import { RESULT_BEGIN, RESULT_END } from '@ignite/plugin-types';

function frame(streamType: number, payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

describe('createDockerStreamDemuxer', () => {
  it('splits multiplexed frames into stdout and stderr', () => {
    const demux = createDockerStreamDemuxer();
    demux.push(frame(1, 'out1'));
    demux.push(frame(2, 'err1'));
    demux.push(frame(1, 'out2'));
    expect(demux.result()).toEqual({ stdout: 'out1out2', stderr: 'err1' });
  });

  it('handles a frame split across chunk boundaries', () => {
    const demux = createDockerStreamDemuxer();
    const f = frame(1, 'hello world');
    demux.push(f.subarray(0, 5));
    demux.push(f.subarray(5));
    expect(demux.result().stdout).toBe('hello world');
  });

  it('falls back to raw mode for non-multiplexed streams', () => {
    const demux = createDockerStreamDemuxer();
    demux.push(Buffer.from('plain text output, no header'));
    expect(demux.result().stdout).toBe('plain text output, no header');
  });
});

describe('parsePluginOutput', () => {
  const payload = { success: true, data: { hello: 'world' } };

  it('parses a sentinel-framed result, ignoring noise around it', () => {
    const stdout = `npm WARN something {stray brace\n${RESULT_BEGIN}${JSON.stringify(payload)}${RESULT_END}\n`;
    expect(parsePluginOutput(stdout, '')).toEqual(payload);
  });

  it('uses the LAST sentinel block when a plugin echoes one', () => {
    const first = `${RESULT_BEGIN}{"success":false}${RESULT_END}`;
    const second = `${RESULT_BEGIN}${JSON.stringify(payload)}${RESULT_END}`;
    expect(parsePluginOutput(`${first}\n${second}`, '')).toEqual(payload);
  });

  it('falls back to legacy brace-matching for old plugin images', () => {
    const stdout = `some log\n${JSON.stringify(payload, null, 2)}\n`;
    expect(parsePluginOutput(stdout, '')).toEqual(payload);
  });

  it('throws the legacy error shape when no JSON is present', () => {
    expect(() => parsePluginOutput('garbage', 'boom')).toThrow(
      /Invalid plugin output format/
    );
  });
});
