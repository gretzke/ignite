import { describe, it, expect } from 'vitest';
import {
  createDockerStreamDemuxer,
  createSentinelLogFilter,
  parsePluginOutput,
  stripSentinelBlocks,
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

  it('flushes a stream shorter than the 8-byte sniff window at result()', () => {
    // A raw/TTY container whose entire output is shorter than the mode
    // sniff must not be silently dropped — '{}' is a legitimate complete
    // plugin output.
    const demux = createDockerStreamDemuxer();
    demux.push(Buffer.from('{}'));
    expect(demux.result().stdout).toBe('{}');
  });

  it('invokes onChunk for the sub-sniff flush at result()', () => {
    const calls: Array<[string, string]> = [];
    const demux = createDockerStreamDemuxer((stream, text) =>
      calls.push([stream, text])
    );
    demux.push(Buffer.from('{}'));
    expect(calls).toEqual([]);
    demux.result();
    expect(calls).toEqual([['stdout', '{}']]);
  });

  it('salvages the payload of a truncated trailing multiplexed frame at result()', () => {
    const demux = createDockerStreamDemuxer();
    demux.push(frame(1, 'complete'));
    // Header declares 100 bytes but the stream dies after 7.
    const truncated = frame(2, 'partial').subarray(0, 8 + 7);
    truncated.writeUInt32BE(100, 4);
    demux.push(truncated);
    const { stdout, stderr } = demux.result();
    expect(stdout).toBe('complete');
    expect(stderr).toBe('partial');
  });

  it('drops a truncated trailing header (no payload bytes) at result()', () => {
    const demux = createDockerStreamDemuxer();
    demux.push(frame(1, 'complete'));
    demux.push(frame(1, 'x').subarray(0, 4)); // partial header only
    expect(demux.result()).toEqual({ stdout: 'complete', stderr: '' });
  });

  it('result() is idempotent — flush happens once', () => {
    const calls: Array<[string, string]> = [];
    const demux = createDockerStreamDemuxer((stream, text) =>
      calls.push([stream, text])
    );
    demux.push(Buffer.from('{}'));
    demux.result();
    demux.result();
    expect(calls).toEqual([['stdout', '{}']]);
    expect(demux.result().stdout).toBe('{}');
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
    const stdout = `npm WARN {stray brace\n${RESULT_BEGIN}${JSON.stringify(payload)}${RESULT_END}\nasync log: ${RESULT_BEGIN}oops, no end`;
    expect(parsePluginOutput(stdout, '')).toEqual(payload);
  });

  it('uses the LAST sentinel block when a plugin echoes one', () => {
    const first = `${RESULT_BEGIN}{"success":false}${RESULT_END}`;
    const second = `${RESULT_BEGIN}${JSON.stringify(payload)}${RESULT_END}`;
    expect(parsePluginOutput(`${first}\n${second}`, '')).toEqual(payload);
  });

  it('throws (without an infinite backward scan) when the only RESULT_BEGIN is dangling at position 0', () => {
    // Guards against lastIndexOf clamping a negative fromIndex to 0 and
    // re-finding index 0 forever. Bare JSON after the dangling begin is NOT
    // parsed — there is no legacy fallback.
    const stdout = `${RESULT_BEGIN}no end here\n${JSON.stringify(payload)}`;
    expect(() => parsePluginOutput(stdout, '')).toThrow(
      /No sentinel-framed result/
    );
  });

  it('throws for bare JSON without sentinels (no legacy fallback)', () => {
    const stdout = `some log\n${JSON.stringify(payload, null, 2)}\n`;
    expect(() => parsePluginOutput(stdout, '')).toThrow(
      /No sentinel-framed result/
    );
  });

  it('throws when no result is present at all', () => {
    expect(() => parsePluginOutput('garbage', 'boom')).toThrow(
      /No sentinel-framed result/
    );
  });

  it('throws a JSON parse error for a complete sentinel block with invalid JSON', () => {
    const stdout = `${RESULT_BEGIN}{not valid json}${RESULT_END}`;
    expect(() => parsePluginOutput(stdout, '')).toThrow(/JSON parse error/);
  });
});

describe('createSentinelLogFilter', () => {
  const block = `${RESULT_BEGIN}{"success":true}${RESULT_END}`;

  function collect() {
    const out: string[] = [];
    const filter = createSentinelLogFilter((text) => out.push(text));
    return { out, filter };
  }

  it('passes plain text through unchanged', () => {
    const { out, filter } = collect();
    filter('Compiling 3 files\n');
    expect(out).toEqual(['Compiling 3 files\n']);
  });

  it('suppresses a complete sentinel block within one chunk', () => {
    const { out, filter } = collect();
    filter(`before\n${block}after`);
    expect(out).toEqual(['before\n', 'after']);
  });

  it('suppresses a sentinel block spanning multiple chunks', () => {
    const { out, filter } = collect();
    const whole = `log line\n${block}`;
    filter(whole.slice(0, 15));
    filter(whole.slice(15, 40));
    filter(whole.slice(40));
    expect(out.join('')).toBe('log line\n');
  });

  it('holds back a possible sentinel prefix at the chunk tail, emitting it when disproven', () => {
    const { out, filter } = collect();
    filter('value is <<<IGNITE');
    // '<<<IGNITE' could be the start of RESULT_BEGIN — held back.
    expect(out.join('')).toBe('value is ');
    filter(' tokens>');
    expect(out.join('')).toBe('value is <<<IGNITE tokens>');
  });

  it('drops whitespace-only chunks', () => {
    const { out, filter } = collect();
    filter('\n');
    filter('   ');
    filter('real content\n');
    expect(out).toEqual(['real content\n']);
  });

  it('suppresses everything between BEGIN and END even across whitespace and braces', () => {
    const { out, filter } = collect();
    filter(`${RESULT_BEGIN}{"a":`);
    filter(`1}${RESULT_END}visible`);
    expect(out.join('')).toBe('visible');
  });
});

// Diagnostics (e.g. the plugin-stdout debug echo in PluginExecutionUtils)
// must never quote result payloads — they may carry granted secrets such as
// key-embedding RPC provider URLs.
describe('stripSentinelBlocks', () => {
  it('returns text without sentinels unchanged', () => {
    expect(stripSentinelBlocks('plain log output\n')).toBe(
      'plain log output\n'
    );
  });

  it('removes a framed block, keeping surrounding text', () => {
    const text = `before\n${RESULT_BEGIN}{"secret":"sk-leak"}${RESULT_END}after\n`;
    expect(stripSentinelBlocks(text)).toBe('before\nafter\n');
  });

  it('removes multiple framed blocks', () => {
    const text = `a${RESULT_BEGIN}{"x":1}${RESULT_END}b${RESULT_BEGIN}{"y":2}${RESULT_END}c`;
    expect(stripSentinelBlocks(text)).toBe('abc');
  });

  it('drops an unterminated trailing block entirely', () => {
    // A truncated block must not leak a partial payload.
    const text = `kept${RESULT_BEGIN}{"secret":"sk-lea`;
    expect(stripSentinelBlocks(text)).toBe('kept');
  });
});
