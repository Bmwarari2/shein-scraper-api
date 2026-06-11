/**
 * Synthetic fixtures mirroring the gbRawData structure observed on Shein UK
 * product/search pages. These pin the parser's *logic*; Phase 0 replaces the
 * load-bearing assertions with real captured pages (which are too large and
 * too rights-encumbered to invent here).
 */

const PAD = "<!-- padding -->".repeat(150); // keep classifier's tiny-response check out of the way

export function productPageHtml(overrides: { currencySymbol?: string } = {}): string {
  const sym = overrides.currencySymbol ?? "£";
  const gb = {
    productIntroData: {
      detail: {
        goods_id: "12345678",
        goods_sn: "sw2207155borchild",
        goods_name: "Floral Print Ruffle Hem Dress",
        goods_img: "//img.ltwebstatic.com/images3_pi/main.jpg",
        stock: "50",
        is_on_sale: "1",
      },
      mainSaleAttribute: {
        info: [
          {
            attr_name: "Color",
            attr_value: "Blue",
            goods_id: "12345678",
            goods_url_name: "Floral Print Ruffle Hem Dress",
            goods_image: "//img.ltwebstatic.com/images3_pi/blue.jpg",
          },
          {
            attr_name: "Color",
            attr_value: "Red",
            goods_id: "12345679",
            goods_url_name: "Floral Print Ruffle Hem Dress",
            goods_image: "//img.ltwebstatic.com/images3_pi/red.jpg",
          },
        ],
      },
      saleAttrGroups: {
        skc_sale_attr: [
          {
            attr_name: "Size",
            isSize: "1",
            attr_value_list: [
              { attr_value_id: "755", attr_value_name: "S" },
              { attr_value_id: "756", attr_value_name: "M" },
              { attr_value_id: "757", attr_value_name: "L" },
            ],
          },
        ],
      },
      skcInfo: {
        goods_id: "12345678",
        sku_list: [
          {
            sku_code: "I33xkqme0ppb",
            priceInfo: {
              salePrice: { amount: "11.08", amountWithSymbol: `${sym}11.08` },
              retailPrice: { amount: "15.99", amountWithSymbol: `${sym}15.99` },
            },
          },
        ],
      },
      comboStock: {
        dataMap: { "Size__755,": 8, "Size__756,": 3, "Size__757,": 0 },
        skuMap: {},
      },
      currentSkcImgInfo: {
        skcImages: [
          "//img.ltwebstatic.com/images3_pi/blue-1.jpg",
          "//img.ltwebstatic.com/images3_pi/blue-2.jpg",
        ],
      },
    },
  };

  return `<!DOCTYPE html><html><head>
<title>Floral Print Ruffle Hem Dress | SHEIN UK</title>
<meta name="description" content="A breezy floral dress with a ruffle hem." />
<meta property="og:title" content="Floral Print Ruffle Hem Dress" />
</head><body>
<script>window.gbRawData = ${JSON.stringify(gb)};</script>
${PAD}
</body></html>`;
}

export function searchPageHtml(): string {
  const gb = {
    results: {
      goods_list: [
        {
          goods_id: "111",
          goods_name: "Ditsy Floral Midi Dress",
          goods_url_name: "Ditsy Floral Midi Dress",
          goods_img: "//img.ltwebstatic.com/a.jpg",
        },
        {
          goods_id: "222",
          goods_name: "Ruffle Trim Wrap Dress",
          goods_url_name: "Ruffle Trim Wrap Dress",
          goods_img: "//img.ltwebstatic.com/b.jpg",
        },
        { goods_id: "111", goods_name: "Duplicate Entry", goods_url_name: "dup" },
      ],
    },
  };
  return `<!DOCTYPE html><html><head><title>search | SHEIN UK</title></head>
<body><script>window.gbRawData = ${JSON.stringify(gb)};</script>${PAD}</body></html>`;
}

export function emptyGridPageHtml(): string {
  const gb = { results: { goods_list: [] as unknown[], origin_total: 0 } };
  return `<!DOCTYPE html><html><head><title>search | SHEIN UK</title></head>
<body><script>window.gbRawData = ${JSON.stringify(gb)};</script>${PAD}</body></html>`;
}

export function blockedPageHtml(): string {
  return `<html><head><title>Access Denied</title></head><body>denied</body></html>`;
}

export function driftedPageHtml(): string {
  return `<!DOCTYPE html><html><head><title>Some Dress | SHEIN UK</title></head>
<body><div id="app">client renders here now</div>${PAD}</body></html>`;
}
