import { stripSentinelBlocks } from '../plugins/utils/pluginTransport.js';
// eslint-disable-next-line no-control-regex -- untrusted plugin output boundary
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
export function sanitizePluginString(
  value: unknown,
  cap: number
): string | undefined {
  if (typeof value !== 'string') return undefined;
  return stripSentinelBlocks(value).replace(CONTROL, '').slice(0, cap);
}
