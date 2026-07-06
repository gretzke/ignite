// Credential redaction for anything user-visible or persisted: job params,
// WS frames, error messages embedding git output. A clone URL like
// https://user:ghp_token@github.com/org/repo.git must never reach disk or
// the browser with its userinfo intact.

// Replaces the userinfo portion of every scheme://user[:pass]@host URL
// embedded anywhere in the text. Works on bare URLs and on URLs inside
// longer messages (e.g. git stderr).
export function redactUrlCredentials(text: string): string {
  return text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s@]+@/g, '$1***@');
}

// True when a URL embeds userinfo (https://user:token@host/...). Such URLs
// are rejected at the entry points (repo save/init): the host's ambient
// credentials (helpers, ssh-agent) and the SSH fallback are the supported
// auth story, and secrets embedded in identities would otherwise leak into
// every place the identity is persisted or displayed.
export function hasUrlCredentials(url: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s@]+@/.test(url);
}

// Redacts string values in a params record (job params are shallow
// string-valued records today; non-strings pass through untouched).
export function redactParams<T extends Record<string, unknown>>(params: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = typeof value === 'string' ? redactUrlCredentials(value) : value;
  }
  return out as T;
}
