import { SchemaDriftError } from "../shared/errors.js";
import { deepFindArray, extractGbRawData, extractJsonAssignment, isObj } from "./extract-json.js";
import { httpsify } from "./product.js";

/** A product discovered on a search/category grid — just enough to enqueue it. */
export interface DiscoveredProduct {
  goodsId: string;
  url: string;
  title: string;
}

interface GridItem {
  goods_id?: number | string;
  goods_name?: string;
  goods_url_name?: string;
}

export function productUrlFor(goodsId: string, urlName?: string): string {
  const slug = (urlName ?? "product").trim().replace(/\s+/g, "-");
  return `https://www.shein.co.uk/${slug}-p-${goodsId}.html`;
}

/**
 * Parse a search or category grid page into discovered product URLs.
 * The list lives either inside gbRawData or as a standalone `"goods_list": [...]`
 * assignment. An empty array on a real page means "no more results" (end of
 * pagination), so absence of the structures entirely is drift, but an empty
 * list is not.
 */
export function parseSheinGrid(html: string): DiscoveredProduct[] {
  let list: GridItem[] | null = null;

  const gb = extractGbRawData(html);
  if (gb) {
    const found = deepFindArray(gb, (arr) => {
      const first = arr[0];
      return isObj(first) && "goods_id" in first && "goods_name" in first;
    });
    if (found) list = found as GridItem[];
  }
  if (!list) {
    const extracted = extractJsonAssignment(html, /"goods_list"\s*:/);
    if (Array.isArray(extracted)) list = extracted as GridItem[];
  }
  if (!list) {
    if (!gb) throw new SchemaDriftError("no gbRawData and no goods_list on grid page");
    return []; // real page, no product array → end of results
  }

  const out: DiscoveredProduct[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item?.goods_name || item.goods_id == null) continue;
    const goodsId = String(item.goods_id);
    if (seen.has(goodsId)) continue;
    seen.add(goodsId);
    out.push({
      goodsId,
      url: productUrlFor(goodsId, item.goods_url_name),
      title: String(item.goods_name),
    });
  }
  return out;
}

// httpsify re-exported for grid image use by future callers.
export { httpsify };
