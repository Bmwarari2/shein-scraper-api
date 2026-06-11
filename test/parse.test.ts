import { describe, expect, it } from "vitest";
import { classifyProductHtml } from "../src/parse/classify.js";
import { extractJsonAssignment } from "../src/parse/extract-json.js";
import { parseSheinProduct } from "../src/parse/product.js";
import { parseSheinGrid } from "../src/parse/search.js";
import { SchemaDriftError, WrongCurrencyError } from "../src/shared/errors.js";
import {
  blockedPageHtml,
  driftedPageHtml,
  emptyGridPageHtml,
  productPageHtml,
  searchPageHtml,
} from "./fixtures/make-fixtures.js";

const SOURCE_URL = "https://www.shein.co.uk/Floral-Print-Ruffle-Hem-Dress-p-12345678.html";

describe("extractJsonAssignment", () => {
  it("brace-matches nested structures where a regex would truncate", () => {
    const html = `var x = 1; gbRawData = {"a":{"b":[1,{"c":"}"}]},"d":"\\"{"}; more`;
    expect(extractJsonAssignment(html, /gbRawData\s*=\s*\{/)).toEqual({
      a: { b: [1, { c: "}" }] },
      d: '"{',
    });
  });

  it("handles `\"marker\": [...]` forms", () => {
    const html = `{"goods_list": [{"id":1},{"id":2}], "other": 3}`;
    expect(extractJsonAssignment(html, /"goods_list"\s*:/)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("returns null on malformed JSON instead of throwing", () => {
    expect(extractJsonAssignment("gbRawData = {broken", /gbRawData\s*=\s*\{/)).toBeNull();
  });
});

describe("classifyProductHtml", () => {
  it("ok when gbRawData is present", () => {
    expect(classifyProductHtml(productPageHtml()).kind).toBe("ok");
  });
  it("blocked on challenge/denial pages", () => {
    expect(classifyProductHtml(blockedPageHtml()).kind).toBe("blocked");
  });
  it("drift on a real Shein page without the data blob", () => {
    expect(classifyProductHtml(driftedPageHtml()).kind).toBe("drift");
  });
});

describe("parseSheinProduct", () => {
  const product = parseSheinProduct(productPageHtml(), SOURCE_URL);

  it("extracts identity, money in pence, and discount", () => {
    expect(product.goodsId).toBe("12345678");
    expect(product.title).toBe("Floral Print Ruffle Hem Dress");
    expect(product.price).toEqual({
      currency: "GBP",
      amountPence: 1108,
      retailAmountPence: 1599,
      discountPercent: 31,
    });
    expect(product.quality).toBe("full");
    expect(product.region).toBe("GB");
  });

  it("builds colour × size variants with per-size stock for the default colour", () => {
    expect(product.variants).toHaveLength(6); // 2 colours × 3 sizes
    const blueM = product.variants.find((v) => v.color === "Blue" && v.size === "M");
    expect(blueM?.stock).toEqual({ status: "low_stock", quantity: 3 });
    const blueL = product.variants.find((v) => v.color === "Blue" && v.size === "L");
    expect(blueL?.stock).toEqual({ status: "out_of_stock", quantity: 0 });
    const redS = product.variants.find((v) => v.color === "Red" && v.size === "S");
    expect(redS?.stock.status).toBe("in_stock"); // product-level fallback, no quantity
    expect(redS?.stock.quantity).toBeUndefined();
  });

  it("dedupes the gallery across colour heroes and skcImages, https-normalized", () => {
    expect(product.images).toEqual([
      "https://img.ltwebstatic.com/images3_pi/blue.jpg",
      "https://img.ltwebstatic.com/images3_pi/red.jpg",
      "https://img.ltwebstatic.com/images3_pi/blue-1.jpg",
      "https://img.ltwebstatic.com/images3_pi/blue-2.jpg",
      "https://img.ltwebstatic.com/images3_pi/main.jpg",
    ]);
  });

  it("fails closed on non-GBP prices", () => {
    expect(() => parseSheinProduct(productPageHtml({ currencySymbol: "€" }), SOURCE_URL))
      .toThrow(WrongCurrencyError);
  });

  it("throws SchemaDriftError when the blob is missing", () => {
    expect(() => parseSheinProduct(driftedPageHtml(), SOURCE_URL)).toThrow(SchemaDriftError);
  });
});

describe("parseSheinGrid", () => {
  it("discovers products and dedupes by goodsId", () => {
    const items = parseSheinGrid(searchPageHtml());
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      goodsId: "111",
      url: "https://www.shein.co.uk/Ditsy-Floral-Midi-Dress-p-111.html",
      title: "Ditsy Floral Midi Dress",
    });
  });

  it("returns empty (not drift) for a real page with no results", () => {
    expect(parseSheinGrid(emptyGridPageHtml())).toEqual([]);
  });

  it("throws drift when neither gbRawData nor goods_list exists", () => {
    expect(() => parseSheinGrid("<html><body>nothing here</body></html>")).toThrow(SchemaDriftError);
  });
});
