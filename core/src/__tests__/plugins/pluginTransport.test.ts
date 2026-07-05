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

  it('flips to raw mode mid-stream on an invalid header, keeping earlier frames', () => {
    const demux = createDockerStreamDemuxer();
    demux.push(frame(1, 'framed part'));
    demux.push(Buffer.from('corrupt raw tail'));
    const { stdout, stderr } = demux.result();
    expect(stdout).toBe('framed partcorrupt raw tail');
    expect(stderr).toBe('');
  });

  it('silently drops stream-type 0 (stdin) frames', () => {
    const demux = createDockerStreamDemuxer();
    demux.push(frame(0, 'x'));
    demux.push(frame(1, 'out'));
    expect(demux.result()).toEqual({ stdout: 'out', stderr: '' });
  });

  it('invokes onChunk with each newly decoded payload in order for multiplexed frames', () => {
    const calls: Array<[string, string]> = [];
    const demux = createDockerStreamDemuxer((stream, text) =>
      calls.push([stream, text])
    );
    demux.push(frame(1, 'out1'));
    demux.push(frame(2, 'err1'));
    demux.push(frame(1, 'out2'));
    expect(calls).toEqual([
      ['stdout', 'out1'],
      ['stderr', 'err1'],
      ['stdout', 'out2'],
    ]);
    // onChunk must not change the aggregated result.
    expect(demux.result()).toEqual({ stdout: 'out1out2', stderr: 'err1' });
  });

  it('does not invoke onChunk for dropped stream-type 0 (stdin) frames', () => {
    const calls: Array<[string, string]> = [];
    const demux = createDockerStreamDemuxer((stream, text) =>
      calls.push([stream, text])
    );
    demux.push(frame(0, 'x'));
    demux.push(frame(1, 'out'));
    expect(calls).toEqual([['stdout', 'out']]);
  });

  it('invokes onChunk once per push for raw-mode streams', () => {
    const calls: Array<[string, string]> = [];
    const demux = createDockerStreamDemuxer((stream, text) =>
      calls.push([stream, text])
    );
    demux.push(Buffer.from('plain text output, no header'));
    expect(calls).toEqual([['stdout', 'plain text output, no header']]);
  });

  it('flushes buffered pre-sniff bytes through onChunk in the same call that decides raw', () => {
    const calls: Array<[string, string]> = [];
    const demux = createDockerStreamDemuxer((stream, text) =>
      calls.push([stream, text])
    );
    // Fewer than 8 bytes: mode stays 'unknown', nothing decoded/emitted yet.
    demux.push(Buffer.from('abc'));
    expect(calls).toEqual([]);
    // Crosses the 8-byte sniff threshold with a non-header prefix: mode
    // flips to 'raw' and the whole buffer (old + new bytes) flushes at once.
    demux.push(Buffer.from('defgh right here'));
    expect(calls).toEqual([['stdout', 'abcdefgh right here']]);
    expect(demux.result().stdout).toBe('abcdefgh right here');
  });

  it('invokes onChunk for both the framed part and the raw tail on a mid-stream mode flip', () => {
    const calls: Array<[string, string]> = [];
    const demux = createDockerStreamDemuxer((stream, text) =>
      calls.push([stream, text])
    );
    demux.push(frame(1, 'framed part'));
    demux.push(Buffer.from('corrupt raw tail'));
    expect(calls).toEqual([
      ['stdout', 'framed part'],
      ['stdout', 'corrupt raw tail'],
    ]);
  });

  it('does not require onChunk (omitting it is a no-op)', () => {
    const demux = createDockerStreamDemuxer();
    expect(() => demux.push(frame(1, 'out1'))).not.toThrow();
    expect(demux.result()).toEqual({ stdout: 'out1', stderr: '' });
  });
});

describe('parsePluginOutput', () => {
  const payload = { success: true, data: { hello: 'world' } };

  it('parses a sentinel-framed result, ignoring noise around it', () => {
    const stdout = `npm WARN something {stray brace\n${RESULT_BEGIN}${JSON.stringify(payload)}${RESULT_END}\n`;
    expect(parsePluginOutput(stdout, '')).toEqual(payload);
  });

  it('returns the last COMPLETE block when a dangling RESULT_BEGIN follows it', () => {
    // Noise braces around the block make the legacy fallback misparse, so
    // this only passes if the parser finds the complete sentinel block.
    const stdout = `npm WARN {stray brace\n${RESULT_BEGIN}${JSON.stringify(payload)}${RESULT_END}\nasync log: ${RESULT_BEGIN}oops, no end`;
    expect(parsePluginOutput(stdout, '')).toEqual(payload);
  });

  it('falls through to the legacy path when the only RESULT_BEGIN is dangling at position 0', () => {
    // Also guards against an infinite backward scan (lastIndexOf clamps a
    // negative fromIndex to 0 and would re-find index 0 forever).
    const stdout = `${RESULT_BEGIN}no end here\n${JSON.stringify(payload)}`;
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

  it('throws a JSON parse error for a complete sentinel block with invalid JSON', () => {
    const stdout = `${RESULT_BEGIN}{not valid json}${RESULT_END}`;
    expect(() => parsePluginOutput(stdout, '')).toThrow(/JSON parse error/);
  });

  it('throws a JSON parse error when the legacy brace match is invalid JSON', () => {
    expect(() => parsePluginOutput('log {not valid json} log', '')).toThrow(
      /JSON parse error/
    );
  });
});
