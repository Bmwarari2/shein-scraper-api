/**
 * Classify an unlocker response before parsing. The distinction drives retry
 * behaviour: `blocked` is retryable (fresh session may pass), `drift` is not
 * (the page is real but our expectations broke — that needs a human).
 */

export type FetchClass =
  | { kind: "ok" }
  | { kind: "blocked"; reason: string }
  | { kind: "drift"; reason: string };

const BLOCK_MARKERS: Array<[RegExp, string]> = [
  [/<title>\s*access denied/i, "access-denied title"],
  [/captcha-delivery\.com|px-captcha|geetest|hcaptcha|g-recaptcha/i, "captcha widget"],
  [/please verify you are a human|unusual traffic/i, "verification interstitial"],
  [/cf-browser-verification|challenge-platform/i, "challenge page"],
];

export function classifyProductHtml(html: string): FetchClass {
  // The data blob being present trumps everything — the page is usable.
  if (/gbRawData\s*=\s*\{/.test(html)) return { kind: "ok" };

  for (const [re, reason] of BLOCK_MARKERS) {
    if (re.test(html)) return { kind: "blocked", reason };
  }
  if (html.length < 2_000) {
    return { kind: "blocked", reason: `tiny response (${html.length} bytes)` };
  }

  // Looks like a real Shein page but the state blob is gone: structural drift.
  if (/shein/i.test(html) && /<title>/i.test(html)) {
    return { kind: "drift", reason: "page renders but gbRawData marker is absent" };
  }
  return { kind: "blocked", reason: "unrecognized non-product response" };
}
