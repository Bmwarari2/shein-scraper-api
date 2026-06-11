# shein-scraper-api

Personal API that scrapes SHEIN UK product data (GBP) into structured JSON —
deterministic parsing of Shein's embedded `gbRawData` state (no LLM), bot
walls handled by Bright Data Web Unlocker, deployed on GCP (Cloud Run +
Cloud Tasks + Firestore).

Full design: [docs/PLAN.md](docs/PLAN.md).

## Status

- ✅ Phase 1 — parsers (product, search/category grid, block/drift classifier), fixture-tested
- ✅ Phase 2 — Bright Data fetch client, budget ledger, GBP fail-closed enforcement
- ✅ Phase 3 — jobs, queue (inline + Cloud Tasks), memory + Firestore stores, caching
- ✅ Phase 4 — REST API: async jobs, polling, paginated results, idempotency, API-key auth
- ⬜ Phase 0 backfill — capture **real** page/review fixtures and verify Bright Data
  request options + the reviews endpoint (`src/parse/reviews.ts` is a stub until then)
- ⬜ Phase 5 — deploy (`infra/setup.sh` bootstraps the GCP project)
- ⬜ Phase 6 — dashboards/alerts wiring, webhooks delivery task, image mirroring

## Quickstart (local)

```bash
npm install
npm test            # parser + end-to-end flow tests (no network)
cp .env.example .env  # fill BRIGHTDATA_API_TOKEN + API_KEYS

# one-off CLI scrape (real unlocker call):
npm run scrape -- "https://www.shein.co.uk/<product>-p-<id>.html"

# run the API with in-process queue + memory store:
npm run dev:api
```

```bash
curl -s -X POST localhost:8080/v1/jobs \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"type":"search","query":"floral midi dress","options":{"maxProducts":10}}'
curl -s localhost:8080/v1/jobs/<jobId> -H "X-API-Key: $KEY"
curl -s localhost:8080/v1/jobs/<jobId>/results -H "X-API-Key: $KEY"
```

## API

| Endpoint | Purpose |
|---|---|
| `POST /v1/jobs` | Create a scrape job (`product` \| `search` \| `category`). Returns `202 {jobId}`. Supports `Idempotency-Key`. |
| `GET /v1/jobs/:id` | Job status, counts (`discovered/succeeded/cached/blocked/parseErrors`), per-item errors. |
| `GET /v1/jobs/:id/results` | Cursor-paginated `Product[]`; streams in while the job runs. |
| `GET /v1/products/:goodsId` | Latest cached product snapshot. |

All prices are integer **pence** with `currency: "GBP"` — the parser fails
closed on any other currency. See `src/schema/product.ts` for the full shape.

## Cost guardrails

Daily in-code unlocker budget (`SCRAPE_DAILY_BUDGET`) → Cloud Tasks dispatch
rate caps → Bright Data zone spend cap → GCP billing alerts. No JS rendering
unless the plain fetch lacks the data blob; images are never fetched through
the unlocker.

## Legal

Shein's ToS prohibits scraping; reviews/images carry third-party rights. Keep
scraped data private and don't redistribute it.
