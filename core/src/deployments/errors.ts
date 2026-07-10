// Errors persisted in a run are user-visible and durable. Keep transport
// sentinels, endpoint URLs, and unexpectedly huge plugin diagnostics out.
import { stripSentinelBlocks } from '../plugins/utils/pluginTransport.js';

const MAX_RUN_ERROR_CHARS = 500;

export function sanitizeRunError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return stripSentinelBlocks(message)
    .replace(/https?:\/\/[^\s"']+/gi, '[redacted endpoint]')
    .replace(/\b(?:wss?):\/\/[^\s"']+/gi, '[redacted endpoint]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_RUN_ERROR_CHARS) || 'Deployment execution failed';
}
