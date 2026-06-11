import { describe, expect, it } from "vitest";
import { canonicalSheinUrl, extractGoodsId, searchUrl } from "../src/fetch/canonical.js";

describe("canonicalSheinUrl", () => {
  it("pins the UK host and strips tracking params", () => {
    expect(
      canonicalSheinUrl("https://us.shein.com/Some-Dress-p-123.html?src_module=ads&mallCode=1#x"),
    ).toBe("https://www.shein.co.uk/Some-Dress-p-123.html");
  });

  it("rejects non-Shein URLs", () => {
    expect(() => canonicalSheinUrl("https://evil.example.com/p-1.html")).toThrow();
  });
});

describe("extractGoodsId", () => {
  it("reads -p-<id>.html paths and goods_id params", () => {
    expect(extractGoodsId("https://www.shein.co.uk/X-p-98765.html")).toBe("98765");
    expect(extractGoodsId("https://www.shein.co.uk/page?goods_id=4242")).toBe("4242");
    expect(extractGoodsId("https://www.shein.co.uk/cat/dresses")).toBeNull();
  });
});

describe("searchUrl", () => {
  it("builds UK pdsearch URLs with pagination", () => {
    expect(searchUrl("floral midi dress")).toBe(
      "https://www.shein.co.uk/pdsearch/floral%20midi%20dress/",
    );
    expect(searchUrl("dress", 3)).toBe("https://www.shein.co.uk/pdsearch/dress/?page=3");
  });
});
