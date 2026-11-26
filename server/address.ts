// One way to read a web address, used for judging, granting and opening alike, so
// no two places can disagree about which site it is. Also used by the window.

const FULL = /^https?:\/\/[^/]/i;
// A host, perhaps a port, then the rest. "http:/x" is neither this nor a full address.
const BARE = /^(\[[0-9a-f:]+\]|[^:/?#@[\]]+)(:\d{1,5})?([/?#]|$)/i;

/**
 * The address as a URL, or null if it is not a plain web address. Without `bare`
 * it must start with http:// or https://, as it must where Claude Code reads the
 * same text by itself.
 */
export function readAddress(raw: unknown, { bare = true } = {}): URL | null {
  if (typeof raw !== 'string') return null;
  // Browsers quietly drop or turn some characters, which is how addresses mislead.
  if (/[\s\u0000-\u001f\u007f\\]/.test(raw)) return null;
  const full = FULL.test(raw);
  if (!full && !(bare && BARE.test(raw))) return null;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(raw);
  let url: URL;
  try {
    url = new URL(full ? raw : `${local ? 'http' : 'https'}://${raw}`);
  } catch {
    return null;
  }
  // "https://bank.example@evil.example" is a trick, never an address someone means.
  if (url.username || url.password || !url.hostname) return null;
  return url;
}

/** The site of an address, with its port if it has one; empty if it is not a plain web address. */
export function siteOf(raw: unknown, options?: { bare?: boolean }): string {
  return readAddress(raw, options)?.host ?? '';
}
