// Framing protocol for plugin results on stdout. The runner wraps its JSON
// result in sentinels so the host never has to guess which braces on stdout
// are the result. Old images without sentinels hit the host's legacy parser.
export const RESULT_BEGIN = "<<<IGNITE_RESULT_BEGIN>>>";
export const RESULT_END = "<<<IGNITE_RESULT_END>>>";

export function frameResult(result: unknown): string {
  return `\n${RESULT_BEGIN}${JSON.stringify(result)}${RESULT_END}`;
}
