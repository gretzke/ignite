/** Convert Git's scp shorthand into a WHATWG-parsable SSH URL. */
function normalizeForCanonicalUrl(url: string): string {
  if (url.includes("://")) return url;
  const scp = url.match(/^(git@)([^\s/:]+):(.+)$/);
  return scp ? `ssh://${scp[1]}${scp[2]}/${scp[3]}` : url;
}

/** Stable identity used by cache registries and workflow pin comparisons. */
export function canonicalGitUrl(url: string): string {
  try {
    const parsed = new URL(normalizeForCanonicalUrl(url));
    parsed.pathname = parsed.pathname
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return normalizeForCanonicalUrl(url);
  }
}
