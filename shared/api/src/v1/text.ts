/**
 * Makes collaborator-authored text safe for compact display surfaces. This is
 * deliberately browser-safe: consumers of @ignite/api cannot assume Buffer.
 */
export function sanitizeDisplayText(value: string, maxLen = 256): string {
  const clean = value.replace(
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    "",
  );
  if (maxLen < 1) return "";
  return clean.length > maxLen
    ? `${clean.slice(0, Math.max(0, maxLen - 1))}\u2026`
    : clean;
}
