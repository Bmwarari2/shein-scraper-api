import { SchemaDriftError } from "../shared/errors.js";
import {
  productSchema,
  SCHEMA_VERSION,
  type Product,
  type StockStatus,
  type Variant,
} from "../schema/product.js";
import {
  deepCollect,
  deepFind,
  extractGbRawData,
  isObj,
  type Node,
} from "./extract-json.js";
import { discountPercent, gbpPenceFromPriceNode, priceFromSku } from "./money.js";

export const PARSER_VERSION = "product-parser/1";

/** Prepend https: to Shein's protocol-relative image URLs. */
export function httpsify(u: unknown): string {
  if (typeof u !== "string") return "";
  const t = u.trim();
  return t.startsWith("//") ? `https:${t}` : t;
}

function metaContent(html: string, name: string): string {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)["']`,
    "i",
  );
  return html.match(re)?.[1] ?? "";
}

/**
 * Parse a Shein UK product page into a validated Product document.
 * Throws SchemaDriftError (incl. WrongCurrencyError) when the page is real but
 * unusable — callers must surface that, not swallow it.
 */
export function parseSheinProduct(html: string, sourceUrl: string): Product {
  const gb = extractGbRawData(html);
  if (!gb) throw new SchemaDriftError("gbRawData assignment not found");

  // Identity: the detail node is the only one carrying name + id + sn together.
  const detail = deepFind(gb, (n) =>
    typeof n.goods_name === "string" && n.goods_id != null && "goods_sn" in n);
  if (!detail) throw new SchemaDriftError("product detail node (goods_name/goods_id/goods_sn) not found");

  const goodsId = String(detail.goods_id);
  const title = String(detail.goods_name);

  // SKC nodes: one per colour, each carrying its own sku_list with priceInfo.
  const skcNodes = deepCollect(gb, (n) => Array.isArray(n.sku_list) && n.sku_list.length > 0);
  const defaultSkc = skcNodes.find((s) => String(s.goods_id) === goodsId) ?? skcNodes[0];

  // Price: default colour's first SKU; fall back to any deep salePrice node.
  let sale = 0;
  let retail = 0;
  if (defaultSkc) {
    const sku0 = (defaultSkc.sku_list as Node[])[0];
    if (isObj(sku0)) ({ sale, retail } = priceFromSku(sku0));
  }
  if (sale === 0) {
    const priceNode = deepFind(gb, (n) => isObj(n.salePrice) && "amount" in (n.salePrice as Node));
    if (priceNode) sale = gbpPenceFromPriceNode(priceNode.salePrice);
  }
  if (sale === 0) throw new SchemaDriftError("no resolvable GBP sale price");

  // Colours: mainSaleAttribute info[] entries flagged as Color.
  const msa = deepFind(gb, (n) =>
    Array.isArray(n.info) && (n.info as Node[]).some((x) => isObj(x) && x.attr_name === "Color"));
  const colours = msa
    ? (msa.info as Node[]).filter((c): c is Node => isObj(c) && c.attr_name === "Color")
    : [];

  // Sizes: a sale-attribute node flagged as Size.
  const sizeAttr = deepFind(gb, (n) =>
    (n.attr_name === "Size" || n.isSize === "1") && Array.isArray(n.attr_value_list));
  const sizes = sizeAttr ? (sizeAttr.attr_value_list as Node[]).filter(isObj) : [];

  // Per-size stock for the default colour: comboStock.dataMap keys "Size__<id>,".
  const combo = deepFind(gb, (n) => isObj(n.dataMap) && isObj(n.skuMap));
  const stockBySizeId: Record<string, number> = {};
  if (combo) {
    for (const [k, v] of Object.entries(combo.dataMap as Node)) {
      const m = k.match(/Size__(\d+),$/);
      if (m) stockBySizeId[m[1]!] = Number(v) || 0;
    }
  }
  const productStock = Number(detail.stock ?? 0) || 0;
  const onSale = detail.is_on_sale !== "0";

  // Gallery: every colour's hero image + the default colour's full skcImages set.
  const skcImgNode = deepFind(gb, (n) =>
    Array.isArray(n.skcImages) && (n.skcImages as unknown[]).length > 0);
  const skcImages = skcImgNode
    ? (skcImgNode.skcImages as unknown[]).map(httpsify).filter(Boolean)
    : [];
  const images = [...new Set([
    ...colours.map((c) => httpsify(c.goods_image)),
    ...skcImages,
    httpsify(detail.goods_img),
  ].filter(Boolean))];

  // Variants: colour × size with per-size quantities where Shein exposes them
  // (default colour only — other colours fall back to status-level stock).
  const variants: Variant[] = [];
  const colourList: Array<Node | null> = colours.length ? colours : [null];
  const sizeList: Array<Node | null> = sizes.length ? sizes : [null];
  for (const c of colourList) {
    const isDefaultColour = !c || String(c.goods_id ?? goodsId) === goodsId;
    for (const s of sizeList) {
      const color = c ? String(c.attr_value ?? "") : "default";
      const size = s ? String(s.attr_value_name ?? s.attr_value_name_en ?? "") : "one-size";
      if (!color && !size) continue;
      const sizeId = s ? String(s.attr_value_id ?? "") : "";
      const quantity =
        isDefaultColour && sizeId && sizeId in stockBySizeId ? stockBySizeId[sizeId] : undefined;
      const status: StockStatus = !onSale
        ? "out_of_stock"
        : quantity != null
          ? quantity <= 0 ? "out_of_stock" : quantity <= 5 ? "low_stock" : "in_stock"
          : productStock > 0 ? "in_stock" : "unknown";
      variants.push({
        color,
        ...(c && httpsify(c.goods_image) ? { colorImageUrl: httpsify(c.goods_image) } : {}),
        size,
        stock: { status, ...(quantity != null ? { quantity } : {}) },
      });
    }
  }

  const product: Product = {
    schemaVersion: SCHEMA_VERSION,
    goodsId,
    ...(detail.goods_sn ? { goodsSn: String(detail.goods_sn) } : {}),
    sourceUrl,
    region: "GB",
    title,
    description: metaContent(html, "description"),
    price: {
      currency: "GBP",
      amountPence: sale,
      ...(retail > sale ? { retailAmountPence: retail } : {}),
      ...(discountPercent(sale, retail) != null
        ? { discountPercent: discountPercent(sale, retail)! }
        : {}),
    },
    images,
    variants,
    quality: "full",
    scrapedAt: new Date().toISOString(),
    parserVersion: PARSER_VERSION,
  };

  // Fail loud on our own output: a Product that doesn't validate is drift.
  const checked = productSchema.safeParse(product);
  if (!checked.success) {
    throw new SchemaDriftError(`parsed product failed validation: ${checked.error.message}`);
  }
  return checked.data;
}
