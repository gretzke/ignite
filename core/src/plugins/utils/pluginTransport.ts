// Pure transport helpers for plugin execution: Docker stream demultiplexing
// and result extraction. No I/O — unit-testable without a daemon.
import { RESULT_BEGIN, RESULT_END } from '@ignite/plugin-types';

export interface DemuxedOutput {
  stdout: string;
  stderr: string;
}

// Docker exec streams are either multiplexed ([type,0,0,0,len32,payload]
// frames) or raw (TTY). Mode is sniffed from the first 8 bytes.
//
// onChunk (optional) is invoked with each newly decoded payload at the
// moment it's appended to stdout/stderr — for multiplexed frames as they're
// parsed, and for raw-mode flushes (including the mode-sniff transition,
// where any bytes buffered while sniffing flush in the same call that
// decides 'raw'). Omitting it is a strict no-op: identical control flow,
// nothing extra allocated or called.
export function createDockerStreamDemuxer(
  onChunk?: (stream: 'stdout' | 'stderr', text: string) => void
) {
  let muxBuffer: Buffer = Buffer.alloc(0);
  let mode: 'unknown' | 'multiplexed' | 'raw' = 'unknown';
  let stdout = '';
  let stderr = '';

  // Isolate the demuxer's state machine from a caller-supplied onChunk: a
  // throwing callback (e.g. a buggy job-log sink) must not corrupt or abort
  // stream handling. This module is otherwise I/O-free, so failures here are
  // swallowed rather than logged.
  const emit = (stream: 'stdout' | 'stderr', text: string): void => {
    if (!onChunk) return;
    try {
      onChunk(stream, text);
    } catch {
      // swallow — see comment above
    }
  };

  return {
    push(chunk: Buffer): void {
      muxBuffer = Buffer.concat([muxBuffer, chunk]);

      if (mode === 'unknown' && muxBuffer.length >= 8) {
        const looksLikeHeader =
          (muxBuffer[0] === 0 || muxBuffer[0] === 1 || muxBuffer[0] === 2) &&
          muxBuffer[1] === 0 &&
          muxBuffer[2] === 0 &&
          muxBuffer[3] === 0;
        mode = looksLikeHeader ? 'multiplexed' : 'raw';
      }

      if (mode === 'raw') {
        const text = muxBuffer.toString('utf8');
        stdout += text;
        muxBuffer = Buffer.alloc(0);
        emit('stdout', text);
        return;
      }

      while (muxBuffer.length >= 8) {
        const streamType = muxBuffer[0];
        const headerValid =
          (streamType === 0 || streamType === 1 || streamType === 2) &&
          muxBuffer[1] === 0 &&
          muxBuffer[2] === 0 &&
          muxBuffer[3] === 0;
        if (!headerValid) {
          mode = 'raw';
          const text = muxBuffer.toString('utf8');
          stdout += text;
          muxBuffer = Buffer.alloc(0);
          emit('stdout', text);
          break;
        }
        const len = muxBuffer.readUInt32BE(4);
        if (muxBuffer.length < 8 + len) break;
        const payload = muxBuffer.subarray(8, 8 + len);
        if (streamType === 2) {
          const text = payload.toString('utf8');
          stderr += text;
          emit('stderr', text);
        } else if (streamType === 1) {
          const text = payload.toString('utf8');
          stdout += text;
          emit('stdout', text);
        }
        muxBuffer = muxBuffer.subarray(8 + len);
      }
    },
    result(): DemuxedOutput {
      // Flush anything still buffered at stream end rather than dropping it:
      // a stream that ended before the 8-byte mode sniff (short raw output —
      // '{}' is a complete plugin response), or a truncated trailing
      // multiplexed frame whose payload is still worth salvaging for
      // diagnostics. Buffer is cleared so the flush happens exactly once.
      if (muxBuffer.length > 0) {
        if (mode === 'multiplexed') {
          // Partial frame: decode whatever payload bytes arrived after the
          // header. A partial header alone (<8 bytes) carries no payload.
          if (muxBuffer.length > 8) {
            const streamType = muxBuffer[0];
            const text = muxBuffer.subarray(8).toString('utf8');
            if (streamType === 2) {
              stderr += text;
              emit('stderr', text);
            } else if (streamType === 1) {
              stdout += text;
              emit('stdout', text);
            }
          }
        } else {
          // 'unknown': the whole stream was shorter than the sniff window,
          // which can only be raw output.
          const text = muxBuffer.toString('utf8');
          stdout += text;
          emit('stdout', text);
        }
        muxBuffer = Buffer.alloc(0);
      }
      return { stdout, stderr };
    },
  };
}

// Returns the length of the longest suffix of `text` that is a proper
// prefix of `needle` — i.e. the bytes that might be the start of `needle`
// split across a chunk boundary.
function partialSuffixLength(text: string, needle: string): number {
  const max = Math.min(text.length, needle.length - 1);
  for (let i = max; i > 0; i--) {
    if (needle.startsWith(text.slice(text.length - i))) return i;
  }
  return 0;
}

// Wraps a job-log sink so the sentinel-framed result block (a protocol
// detail, not tool output) never reaches user-visible logs, even when the
// block spans chunk boundaries. Whitespace-only chunks are dropped — they
// render as empty log lines. Text held back as a possible sentinel prefix
// is emitted as soon as it is disproven.
export function createSentinelLogFilter(
  onText: (text: string) => void
): (text: string) => void {
  let pending = '';
  let suppressing = false;

  const emit = (text: string): void => {
    if (text.trim().length === 0) return;
    onText(text);
  };

  return (chunk: string): void => {
    let buf = pending + chunk;
    pending = '';

    for (;;) {
      if (suppressing) {
        const end = buf.indexOf(RESULT_END);
        if (end === -1) {
          // Still inside the block: retain only a possible partial
          // RESULT_END at the tail so we can detect completion next chunk;
          // everything else is suppressed.
          pending = buf.slice(
            buf.length - partialSuffixLength(buf, RESULT_END)
          );
          return;
        }
        buf = buf.slice(end + RESULT_END.length);
        suppressing = false;
        continue;
      }

      const begin = buf.indexOf(RESULT_BEGIN);
      if (begin === -1) {
        const hold = partialSuffixLength(buf, RESULT_BEGIN);
        if (buf.length - hold > 0) emit(buf.slice(0, buf.length - hold));
        pending = hold > 0 ? buf.slice(buf.length - hold) : '';
        return;
      }
      if (begin > 0) emit(buf.slice(0, begin));
      buf = buf.slice(begin + RESULT_BEGIN.length);
      suppressing = true;
    }
  };
}

// Extract the plugin's JSON result from the last sentinel-framed block.
// Sentinel framing is the only supported protocol: every plugin (built-in or
// installed) must be bundled with a runPluginCLI that emits it. Throws when
// no complete block is present.
export function parsePluginOutput(stdout: string, stderr: string): unknown {
  // Scan backwards for the last COMPLETE sentinel block: a dangling
  // RESULT_BEGIN (e.g. an async console.log racing shutdown, or a plugin
  // echoing the constant) must not shadow a valid framed result before it.
  // A complete block with invalid JSON still throws — fail loud rather than
  // scanning past a corrupt result.
  let begin = stdout.lastIndexOf(RESULT_BEGIN);
  while (begin !== -1) {
    const end = stdout.indexOf(RESULT_END, begin + RESULT_BEGIN.length);
    if (end !== -1) {
      const json = stdout.slice(begin + RESULT_BEGIN.length, end);
      try {
        return JSON.parse(json);
      } catch (parseError) {
        throw new Error(
          `JSON parse error: ${parseError}. Framed output: "${json}"`
        );
      }
    }
    // lastIndexOf clamps a negative fromIndex to 0, which would re-find a
    // match at index 0 forever — stop explicitly once the start is reached.
    begin = begin > 0 ? stdout.lastIndexOf(RESULT_BEGIN, begin - 1) : -1;
  }

  throw new Error(
    `No sentinel-framed result in plugin output. The plugin must print its ` +
      `result between ${RESULT_BEGIN} and ${RESULT_END} (bundles built with ` +
      `@ignite/plugin-types runPluginCLI do this automatically — rebuild the ` +
      `plugin against a current @ignite/plugin-types). ` +
      `stdout tail: "${stdout.slice(-500)}", stderr tail: "${stderr.slice(-500)}"`
  );
}
