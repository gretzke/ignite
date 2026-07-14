/** Decode URI-escaped text at the presentation boundary without allowing a
 * malformed legacy value to break the page. Internal ids remain untouched. */
export function decodeUrlEncodingForDisplay(value: string): string {
  if (!/%[0-9a-f]{2}/i.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function replaceIdsForDisplay(
  value: string,
  labels: Record<string, string> = {}
): string {
  const labelled = Object.entries(labels)
    .sort(([left], [right]) => right.length - left.length)
    .reduce(
      (text, [id, label]) => (id ? text.replaceAll(id, label) : text),
      value
    );
  return decodeUrlEncodingForDisplay(labelled);
}
