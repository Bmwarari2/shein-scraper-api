/**
 * Phase 2 exit-criteria CLI: scrape one product URL end-to-end and print the
 * structured JSON. Uses the real Bright Data client with an in-memory ledger.
 *
 *   BRIGHTDATA_API_TOKEN=... npm run scrape -- "https://www.shein.co.uk/...-p-12345678.html"
 */
import { BrightDataClient } from "../fetch/brightdata.js";
import { InMemoryLedger } from "../fetch/budget.js";
import { canonicalSheinUrl } from "../fetch/canonical.js";
import { classifyProductHtml } from "../parse/classify.js";
import { parseSheinProduct } from "../parse/product.js";
import { loadConfig } from "../shared/config.js";

const rawUrl = process.argv[2];
if (!rawUrl) {
  console.error("usage: npm run scrape -- <shein product url>");
  process.exit(1);
}

const config = loadConfig();
if (!config.BRIGHTDATA_API_TOKEN) {
  console.error("BRIGHTDATA_API_TOKEN is not set");
  process.exit(1);
}

const fetcher = new BrightDataClient(
  { apiToken: config.BRIGHTDATA_API_TOKEN, zone: config.BRIGHTDATA_ZONE },
  new InMemoryLedger(config.SCRAPE_DAILY_BUDGET),
);

const url = canonicalSheinUrl(rawUrl);
let html = await fetcher.fetchHtml(url);
let cls = classifyProductHtml(html);
if (cls.kind !== "ok") {
  console.error(`plain fetch unusable (${cls.kind}: ${cls.reason}) — retrying with render`);
  html = await fetcher.fetchHtml(url, { render: true });
  cls = classifyProductHtml(html);
}
if (cls.kind !== "ok") {
  console.error(`fetch failed: ${cls.kind} (${cls.reason})`);
  process.exit(2);
}

console.log(JSON.stringify(parseSheinProduct(html, url), null, 2));
