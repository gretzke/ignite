// Pure transport helpers for plugin execution: Docker stream demultiplexing
// and result extraction. No I/O — unit-testable without a daemon.
import { RESULT_BEGIN, RESULT_END } from '@ignite/plugin-types';

export interface DemuxedOutput {
  stdout: string;
  stderr: string;
}

// Docker exec streams are either multiplexed ([type,0,0,0,len32,payload]
// frames) or raw (TTY). Mode is sniffed from the first 8 bytes.
export function createDockerStreamDemuxer() {
  let muxBuffer: Buffer = Buffer.alloc(0);
  let mode: 'unknown' | 'multiplexed' | 'raw' = 'unknown';
  let stdout = '';
  let stderr = '';

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
        stdout += muxBuffer.toString('utf8');
        muxBuffer = Buffer.alloc(0);
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
          stdout += muxBuffer.toString('utf8');
          muxBuffer = Buffer.alloc(0);
          break;
        }
        const len = muxBuffer.readUInt32BE(4);
        if (muxBuffer.length < 8 + len) break;
        const payload = muxBuffer.subarray(8, 8 + len);
        if (streamType === 2) stderr += payload.toString('utf8');
        else if (streamType === 1) stdout += payload.toString('utf8');
        muxBuffer = muxBuffer.subarray(8 + len);
      }
    },
    result(): DemuxedOutput {
      return { stdout, stderr };
    },
  };
}

// Extract the plugin's JSON result: prefer the last sentinel-framed block;
// fall back to the legacy control-char-strip + brace-regex for plugin images
// built before the sentinel protocol. Throws on unparseable output.
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

  // Legacy path — matches the old inline implementation byte-for-byte.
  const cleanOutput = stdout
    .split('')
    .filter((char) => {
      const code = char.charCodeAt(0);
      return (code >= 32 && code <= 126) || code >= 160;
    })
    .join('')
    .trim();
  const jsonMatch = cleanOutput.match(/\{.*\}/s);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      throw new Error(
        `JSON parse error: ${parseError}. Clean output: "${cleanOutput}"`
      );
    }
  }
  throw new Error(
    `Invalid plugin output format. Clean output: "${cleanOutput}", stderr: "${stderr}"`
  );
}
