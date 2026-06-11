/**
 * URL canonicalization: every fetch and every cache key goes through here.
 * UK host pinned (GBP storefront), tracking params stripped — improves cache
 * hit rate and render reliability, and prevents the same product appearing
 * under two URLs.
 */

export function canonicalSheinUrl(url: string): string {
  const u = new URL(url);
  if (!/(^|\.)shein\./i.test(u.hostname)) {
    throw new Error(`not a Shein URL: ${url}`);
  }
  u.protocol = "https:";
  u.hostname = "www.shein.co.uk";
  u.search = "";
  u.hash = "";
  return u.toString();
}

/** goods_id from any Shein product URL form (-p-123.html or goods_id/id params). */
export function extractGoodsId(url: string): string | null {
  return url.match(/-p-(\d+)(?:\.html|$)/)?.[1]
    ?? url.match(/[?&](?:goods_id|id)=(\d+)/)?.[1]
    ?? null;
}

export function isProductUrl(url: string): boolean {
  return extractGoodsId(url) !== null;
}

export function searchUrl(query: string, page = 1): string {
  const base = `https://www.shein.co.uk/pdsearch/${encodeURIComponent(query)}/`;
  return page > 1 ? `${base}?page=${page}` : base;
}

export function categoryPageUrl(categoryUrl: string, page: number): string {
  const u = new URL(canonicalSheinUrl(categoryUrl));
  if (page > 1) u.searchParams.set("page", String(page));
  return u.toString();
}
