# Shein Scraper API — Implementation Plan

**Status:** Planning
**Target platform:** Google Cloud Platform (Cloud Run + Cloud Tasks + Firestore + GCS)
**Unblocking provider:** Bright Data Web Unlocker (Web Unblocker)
**Region/currency:** SHEIN UK (`www.shein.co.uk`), prices in GBP only
**LLM usage:** None in v1. Deterministic parsing is the primary and only extraction path; an LLM fallback is a clearly-bounded future option (Phase 7), not a dependency.

---

## 1. Goals and non-goals

### Goals
- Scrape SHEIN UK product data: title, description, prices (sale/original/discount), images, colour variants, sizes, per-size stock, ratings, and full reviews.
- Accept three input types: a direct product URL, a search description/keyword, or a category URL — with bulk fan-out for the latter two.
- Serve results as structured, schema-validated JSON via an authenticated REST API with async jobs, result polling, and optional webhooks.
- Run cheaply and hands-off on GCP with hard spend guardrails.

### Non-goals (v1)
- No LLM extraction (cut per review — Shein ships its data as embedded JSON; parsing it deterministically is faster, free, and exact).
- No self-hosted headless browser fleet, stealth plugins, or proxy rotation logic — Bright Data Web Unlocker handles the entire anti-bot layer (Akamai sensor data, TLS/JA3 fingerprints, cookies, retries on its side).
- No multi-region support. UK/GBP only; the schema carries `region`/`currency` fields so other regions can be added later without breaking the schema.
- No public/multi-tenant service. Single-owner personal API with API-key auth.

---

## 2. How this plan resolves the critique of the original draft

| Issue in original plan | Resolution here |
|---|---|
| Gemini as primary extractor (cost, latency, hallucination, lossy reviews) | Removed. Deterministic parsing of Shein's embedded `gbRawData` JSON blob and its reviews JSON endpoint. Zod schemas validate every parse; failures alert loudly (§7, §12). |
| Self-maintained stealth (playwright-stealth) vs Akamai | Replaced wholesale by Bright Data Web Unlocker — one endpoint, per-successful-request billing, provider maintains the bypass (§5). |
| Hidden cost bomb (per-GB residential bandwidth, rendering images) | Web Unlocker is billed per successful request, not per GB. We additionally: never request JS rendering unless the non-rendered page lacks the data blob; never fetch images/fonts/CSS through the unlocker; download images (when needed at all) directly from Shein's public CDN with a plain HTTP client; cache aggressively; enforce a daily request budget in code plus Bright Data zone spend caps and GCP budget alerts (§5.4, §12). |
| Region/currency unpinned | Hard-pinned: UK storefront host, Bright Data geo `country=gb`, GBP cookie/param forced, and the parser **rejects** any response whose currency is not GBP rather than storing wrong numbers (§5.3). |
| Naive schema (`price: float`, no currency, flat sizes) | Full schema: integer pence, explicit `currency: "GBP"`, per-SKU variants with stock/price/images, rich review objects, provenance metadata, `schemaVersion` (§7). |
| Sync/async confusion, no result retrieval, no durable storage | Everything is a job: `202 + jobId`, polling endpoints, cursor-paginated results, optional signed webhooks. Firestore persists jobs/products durably; no Redis anywhere (§8, §9). |
| No auth on our own API | API-key auth + per-key rate limits + Cloud Run ingress controls (§8.1, §13). |
| No block detection / retry / monitoring / drift alerting | Explicit block-vs-page classifier, Cloud Tasks managed retries with backoff, log-based metrics for success/block/parse-failure rates, alert policies, fail-loud Zod validation (§6.4, §12). |
| No image storage story | URLs stored by default; optional lazy mirror to GCS fetched directly from Shein's CDN (no unlocker cost) (§10). |
| Two languages straddled (Node+Python) | One language: TypeScript/Node 22 end to end (§4). |

---

## 3. Architecture overview

```
                         ┌────────────────────────── GCP project ──────────────────────────┐
                         │                                                                  │
 client ── HTTPS ──────▶ │  API service (Cloud Run, scale-to-zero)                          │
   X-API-Key             │   • validates input, authenticates, rate-limits                  │
                         │   • creates job in Firestore                                     │
                         │   • enqueues tasks ──────────────┐                               │
                         │   • serves job status & results  │                               │
                         │                                  ▼                               │
                         │  Cloud Tasks queue (managed retries, dispatch rate cap)          │
                         │                                  │  HTTP push (OIDC-signed)      │
                         │                                  ▼                               │
                         │  Worker service (Cloud Run, scale-to-zero, concurrency-capped)   │
                         │   • budget check → fetch via Bright Data Web Unlocker            │
                         │   • block detection → classify / let Cloud Tasks retry           │
                         │   • deterministic parse (gbRawData / reviews JSON / search grid) │
                         │   • Zod validation → Firestore (products, reviews, job progress) │
                         │   • optional: mirror images to GCS (direct CDN fetch)            │
                         │   • fires webhook on job completion (HMAC-signed)                │
                         │                                                                  │
                         │  Firestore (jobs, products, reviews, api_keys, request ledger)   │
                         │  GCS bucket (optional image mirror)                              │
                         │  Secret Manager (Bright Data creds, webhook secret, API keys)    │
                         │  Cloud Monitoring (metrics, dashboards, alert policies, budgets) │
                         └──────────────────────────────────────────────────────────────────┘
                                                  │
                                                  ▼ outbound only
                              Bright Data Web Unlocker (zone: shein_uk, country=gb)
                                                  │
                                                  ▼
                                          www.shein.co.uk
```

Why these GCP pieces (and not a lift of the Railway design):

- **Cloud Run** for both API and worker: scales to zero (a personal project costs pennies when idle), no Chromium means small images and fast cold starts, and per-service concurrency caps double as a politeness/spend throttle.
- **Cloud Tasks** instead of Redis+BullMQ/Celery: fully managed queue with built-in exponential-backoff retries, scheduled delivery, and — critically — `maxDispatchesPerSecond`/`maxConcurrentDispatches` knobs that put a hard ceiling on how fast we can spend Web Unlocker requests. Removes Redis (and Memorystore's ~$35/mo floor) entirely.
- **Firestore (Native mode)** instead of Postgres: serverless, generous free tier, zero idle cost, and the data is naturally document-shaped (a product with nested variants/reviews). Cloud SQL's smallest always-on instance would be the single biggest line item in this project for no benefit at this scale. (If relational querying becomes a real need later, export to BigQuery or migrate to Cloud SQL; the repository layer in §4 isolates that decision.)
- **Secret Manager** for all credentials; nothing in env files or the repo.

---

## 4. Tech stack (one language)

| Concern | Choice |
|---|---|
| Runtime | Node 22, TypeScript, ESM |
| API framework | Fastify (built-in JSON-schema validation, fast, small) |
| Validation/schemas | Zod (single source of truth → infer TS types, generate OpenAPI via `zod-openapi`) |
| HTTP client | Native `fetch` with `undici` proxy agent for the unlocker proxy mode |
| HTML/JSON extraction | Brace-matching extractor for `gbRawData` (no full DOM parse needed); `cheerio` only for meta-tag fallback |
| Persistence | `@google-cloud/firestore`, `@google-cloud/storage`, `@google-cloud/tasks` |
| Testing | Vitest; recorded HTML/JSON fixtures for parser tests |
| Deploy | Docker (distroless Node image), GitHub Actions → Artifact Registry → Cloud Run |

Proposed repository layout (new standalone repo):

```
shein-scraper-api/
├── src/
│   ├── api/            # Fastify app: routes, auth, rate limiting, OpenAPI
│   ├── worker/         # task handlers: product, search, category, reviews
│   ├── fetch/          # Bright Data client, budget ledger, block classifier
│   ├── parse/          # gbRawData extractor, product/search/review parsers
│   ├── schema/         # Zod schemas (Product, Review, Job, API I/O) + schemaVersion
│   ├── store/          # Firestore repositories, GCS image mirror
│   └── shared/         # config, logging (structured), errors
├── test/
│   └── fixtures/       # captured Shein HTML/JSON pages (sanitized) for parser tests
├── infra/              # Terraform (or gcloud setup script) for queue, Firestore, GCS, alerts
├── Dockerfile
└── .github/workflows/deploy.yml
```

---

## 5. Fetch layer — Bright Data Web Unlocker

### 5.1 Integration mode
Use Web Unlocker in **proxy mode** (zone credentials via `brd.superproxy.io`, routed through an `undici` ProxyAgent) so requests look like ordinary `fetch` calls; the unlocker transparently handles Akamai/Cloudflare challenges, fingerprints, cookies, and its own retries. Confirm current endpoint/headers against Bright Data docs during Phase 0 — their product naming and per-request options (e.g., forcing/forbidding JS render) change periodically.

Zone configuration (Bright Data dashboard):
- Dedicated zone `shein_uk`, geo-targeted **country = GB** so the storefront serves UK content natively.
- **Zone-level spend cap** set low (e.g., $10/day) as the outermost financial fuse.
- Shein may be classified as a "premium domain" with a higher per-request rate — confirm pricing for `shein.co.uk` specifically in Phase 0 before committing to volume estimates.

### 5.2 What we fetch (and what we never fetch)
| Need | Request | Render? |
|---|---|---|
| Product data | `GET https://www.shein.co.uk/...-p-{goods_id}.html` | No. Shein server-renders the `gbRawData` state blob into the HTML; JS rendering is requested **only** as an automatic one-time retry if the blob is absent from the plain response. |
| Search → product URLs | `GET https://www.shein.co.uk/pdsearch/{query}/?page=N` | Same policy. |
| Category → product URLs | The category URL with `?page=N` | Same policy. |
| Reviews | Shein's paginated reviews JSON endpoint for the `goods_id` (captured and verified in Phase 0; called directly through the unlocker — returns JSON, no HTML parsing) | No. |
| Images | **Never through the unlocker.** Image URLs come out of the JSON. If mirroring is enabled, download from Shein's public image CDN with a plain direct `fetch` — the CDN is not behind the bot wall. | n/a |

URL canonicalization before fetching: force `www.shein.co.uk` host (mobile/regional hosts ship different markup), strip tracking query params and fragments — improves cache hit rate and fetch reliability.

### 5.3 GBP/UK enforcement (not just preference)
1. UK host + Bright Data `country=gb` geo.
2. Force currency via Shein's currency cookie/param (`currency=GBP` — exact mechanism verified in Phase 0).
3. **Parser-level assertion:** every parsed price node carries a currency code in `gbRawData`. If it is anything other than GBP, the item **fails closed** — marked `parse_error: wrong_currency`, alerted, never stored — so a silent geo misconfiguration can't poison the dataset with mislabeled numbers.

### 5.4 Cost guardrails (the "hidden cost bomb" answer)
Web Unlocker bills per **successful request**, so the levers are request count and the render premium:
- **No rendering by default** (render is the expensive variant); automatic single render-retry only on missing data blob.
- **No asset traffic** through the unlocker (images/CSS/fonts never requested).
- **Cache-first** (§11): a product fetched within its TTL is served from Firestore, zero unlocker calls.
- **In-code daily ledger:** every unlocker call is written to a `scrape_calls` ledger; a configurable daily cap (default e.g. 500 calls/day) makes the worker refuse further fetches with a clear `BUDGET_EXCEEDED` job error.
- **Queue throttle:** Cloud Tasks `maxDispatchesPerSecond` (e.g., 1–2 rps) and `maxConcurrentDispatches` (e.g., 4) bound burst spend and keep traffic polite.
- **Bulk caps:** `maxProducts` per job (default 50, hard max 500), `maxReviewPages` per product (default 3).
- **Outer fuses:** Bright Data zone spend cap + GCP billing budget alerts at 50/80/100%.

---

## 6. Extraction layer — deterministic parsers

### 6.1 Product parser
Shein product pages embed the full product state as a `gbRawData = {...}` assignment. Extraction:
1. Locate the marker and **brace/bracket-match** the JSON (a regex truncates on nested braces); `JSON.parse`.
2. Resilient navigation: rather than hardcoding deep paths (which drift), use bounded depth-first searches for structurally identifiable nodes — the detail node (`goods_name` + `goods_id` + `goods_sn`), SKC/colour nodes (objects carrying `sku_list` with `priceInfo`), the colour attribute list, the size attribute list, and the size→stock `dataMap`.
3. Build the `Product` document (§7): per-colour × per-size variants with per-size stock where Shein exposes it, per-SKU sale/retail price in pence, discount derived (never trusted blindly from a display string), image gallery deduped across colour swatches + the default colour's full `skcImages` gallery.
4. **Fallback (degraded, flagged):** if `gbRawData` is unusable but the page is real, parse meta tags only and mark the result `quality: "partial"` — never silently pass off a partial parse as complete.

### 6.2 Search and category parsers (bulk fan-out)
- Search: `pdsearch/{query}` pages embed a `goods_list` array (inside `gbRawData` or as a standalone JSON assignment). Extract `goods_id`/`goods_url_name`, build canonical product URLs.
- Category: same grid structure; paginate with `?page=N` until `maxProducts` or an empty page.
- Each discovered URL is **deduped against the job and the cache**, then enqueued as an individual product task — so one bulk job degrades gracefully (per-product retries, partial results available while running).

### 6.3 Reviews parser
Reviews are not LLM-summarized strings; they come from Shein's paginated reviews JSON endpoint and are stored losslessly: rating, date, review text, language/translation flag, colour+size purchased, fit feedback, member sizing info if present, review image URLs. `maxReviewPages` caps cost; rating average/count also come from the endpoint's aggregate block.

### 6.4 Block detection and schema-drift handling (fail loud)
Every fetch response is classified before parsing:
- `OK` — data blob/JSON present → parse.
- `BLOCKED` — challenge markers, captcha page, abnormal status, or suspiciously tiny HTML → **throw retryable**; Cloud Tasks redelivers with exponential backoff (fresh unlocker session per attempt). After max retries, job item is marked `blocked` with diagnostics.
- `SCHEMA_DRIFT` — page is real (title present, no challenge) but the expected JSON structure is missing or Zod validation of the parsed output fails → **non-retryable**, marked `parse_error`, and counted into a drift metric that alerts (§12). Drift must page the owner, not return nulls.

Parsers are developed against **recorded fixtures** (real captured pages checked into `test/fixtures/`) so drift shows up as failing tests, and a fixed weekly "canary" job scrapes 3 known products and alerts on any non-`OK` outcome — catching drift before a real job does.

---

## 7. Data model and JSON schema

Single source of truth: Zod schemas in `src/schema/`, with `schemaVersion` stamped on every stored document. Money is **integer pence** with an explicit currency literal — no floats.

```ts
// schemaVersion: 1  (bump on any breaking field change; old docs remain readable)

Price {
  currency: "GBP"            // literal; parser rejects anything else
  amountPence: number        // integer
  retailAmountPence?: number // strike-through/original price, if higher
  discountPercent?: number   // derived: round(100 * (retail - sale) / retail)
}

Variant {
  skuCode?: string           // Shein sku identifier when exposed
  color: string
  colorImageUrl?: string     // swatch/colour hero image
  size: string               // as displayed (UK sizing)
  sizeLocal?: string         // secondary size label when Shein shows one
  price?: Price              // per-SKU price when it differs from product price
  stock: { status: "in_stock" | "low_stock" | "out_of_stock" | "unknown",
           quantity?: number }   // quantity only where Shein exposes per-size stock
}

Review {
  reviewId: string
  rating: number             // 1–5
  date: string               // ISO 8601
  text: string
  language?: string
  translated?: boolean
  colorPurchased?: string
  sizePurchased?: string
  fitFeedback?: "true_to_size" | "runs_small" | "runs_large" | "unknown"
  imageUrls: string[]
}

Product {
  schemaVersion: 1
  goodsId: string            // Shein goods_id — primary key
  goodsSn?: string
  sourceUrl: string          // canonical UK product URL
  region: "GB"
  title: string
  description: string
  categoryPath?: string[]    // breadcrumb where available
  brand?: string
  price: Price               // default-colour price
  images: string[]           // original Shein CDN URLs, https-normalized, deduped
  mirroredImages?: { sourceUrl: string, gcsUri: string }[]  // only if mirroring enabled
  variants: Variant[]
  rating?: { average: number, count: number }
  reviews?: Review[]         // present when includeReviews=true
  reviewsTruncated?: boolean // true if maxReviewPages cut pagination short
  quality: "full" | "partial"   // partial = meta-tag fallback parse
  scrapedAt: string          // ISO 8601
  parserVersion: string      // git SHA / semver of the parser that produced this
}

Job {
  jobId: string
  type: "product" | "search" | "category"
  input: { url?: string, query?: string }
  options: { maxProducts, includeReviews, maxReviewPages, freshness, webhookUrl? }
  status: "queued" | "running" | "completed" | "completed_with_errors" | "failed"
  counts: { discovered, succeeded, blocked, parseErrors, cached }
  errors: { itemUrl, kind: "blocked"|"parse_error"|"budget_exceeded"|..., detail }[]
  createdAt / startedAt / finishedAt
  apiKeyId: string           // attribution for rate limits and the ledger
}
```

Firestore collections: `jobs`, `jobs/{id}/results` (refs to products in scrape order), `products` (keyed by `goodsId`; latest snapshot + `scrapedAt`), `products/{id}/snapshots` (optional price history), `api_keys`, `scrape_calls` (daily ledger).

---

## 8. API design

### 8.1 Auth and limits
- `X-API-Key` header on every request; keys stored hashed in Firestore with per-key rate limit (e.g., 60 req/min) and per-key daily scrape quota.
- Cloud Run worker service is **not** publicly invokable — it accepts only OIDC-authenticated pushes from the Cloud Tasks service account.
- 429 with `Retry-After` on rate-limit; 402-style `BUDGET_EXCEEDED` error body when the daily scrape budget is exhausted.

### 8.2 Endpoints (everything async — no synchronous scraping endpoint)

```
POST /v1/jobs
  body: {
    type: "product" | "search" | "category",
    url?: string,            // product/category
    query?: string,          // search description, e.g. "floral summer midi dress"
    options?: {
      maxProducts?: number,        // bulk cap (default 50, max 500)
      includeReviews?: boolean,    // default false (reviews cost extra requests)
      maxReviewPages?: number,     // default 3
      freshness?: "cache_ok" | "max_age:<seconds>" | "force",  // default cache_ok
      webhookUrl?: string          // optional completion callback
    }
  }
  headers: Idempotency-Key (optional — same key returns the same job)
  → 202 { jobId, status: "queued", estimatedRequests }

GET  /v1/jobs/{jobId}
  → Job document: status, counts, per-item errors (a bulk job with some blocked
    items finishes as "completed_with_errors" — partial success is a first-class state)

GET  /v1/jobs/{jobId}/results?cursor=&limit=
  → { items: Product[], nextCursor? }   // streams in while the job is still running

GET  /v1/products/{goodsId}
  → latest cached Product (404 if never scraped); ?refresh=true enqueues a re-scrape job

GET  /v1/health        → liveness/readiness
GET  /v1/openapi.json  → generated from the Zod schemas
```

### 8.3 Webhooks
On terminal job status, POST the Job summary (plus results URL) to `webhookUrl`, signed with an HMAC header (`X-Signature: sha256=...`, shared secret from Secret Manager); retry delivery a few times via a Cloud Task. Webhook is convenience — polling is always sufficient.

### 8.4 Error model
Uniform error body `{ error: { code, message, retryable, details? } }` with stable codes: `INVALID_INPUT`, `UNAUTHORIZED`, `RATE_LIMITED`, `BUDGET_EXCEEDED`, `BLOCKED_UPSTREAM`, `PARSE_ERROR`, `NOT_FOUND`.

---

## 9. Queueing and workers

- One Cloud Tasks queue, task types `scrape_product`, `scrape_search_page`, `scrape_category_page`, `fetch_reviews_page`, `deliver_webhook`.
- Queue config: `maxDispatchesPerSecond: 2`, `maxConcurrentDispatches: 4`, `maxAttempts: 4`, exponential backoff `minBackoff: 30s → maxBackoff: 10m`. Retryable failures (BLOCKED, transient 5xx, unlocker timeouts) throw → Cloud Tasks redelivers; non-retryable (SCHEMA_DRIFT, wrong currency, invalid URL) return 200 with the item marked failed so the queue doesn't spin.
- Handlers are **idempotent** (Cloud Tasks is at-least-once): task carries `jobId + itemKey`; a completed item in Firestore short-circuits redelivery.
- Worker Cloud Run: `concurrency` low (e.g., 4), 1 vCPU / 512 MB (no browser → tiny footprint), request timeout 120 s, min instances 0.

## 10. Image handling

Default: store original Shein CDN URLs only (zero cost; URLs are long-lived). Optional `MIRROR_IMAGES=true`: after a successful parse, a low-priority task downloads each image **directly from the CDN** (plain fetch, no unlocker) into a GCS bucket (`gs://<project>-shein-images/{goodsId}/{hash}.jpg`), recorded in `mirroredImages`. Lifecycle rule deletes objects after N days if storage growth matters.

## 11. Caching strategy

- Key: `goodsId` (canonical). On job intake and on fan-out, items whose cached `scrapedAt` is within TTL are served from Firestore and counted as `cached` — no unlocker spend.
- Default TTL: **6 hours** for product data (prices/discounts move fast on Shein); reviews reuse a **7-day** TTL since they're append-mostly. `freshness: "force"` bypasses; `"max_age:<s>"` lets callers tighten or loosen per job.
- Search/category discovery pages are cached briefly (e.g., 1 hour) keyed by normalized query+page.

## 12. Observability and spend guardrails

- **Structured JSON logs** (one event per fetch: outcome class, latency, render-used, bytes, jobId) → log-based metrics in Cloud Monitoring:
  - `scrape_success_rate`, `scrape_block_rate`, `parse_error_rate`, `unlocker_calls_per_day`, `cache_hit_rate`.
- **Alert policies:** block rate > 20% over 1 h; any `SCHEMA_DRIFT` events > 3/day; daily ledger > 80% of cap; weekly canary job failure. Notification channel: email (wanderibrian2@gmail.com).
- **Dashboards:** one Cloud Monitoring dashboard with the five metrics above plus Cloud Run error rates and queue depth.
- **Money fuses, layered:** in-code daily ledger cap → Cloud Tasks dispatch rate → Bright Data zone spend cap → GCP billing budget alerts (50/80/100%).

## 13. Security

- All secrets (Bright Data zone creds, webhook HMAC secret, API key pepper) in Secret Manager, mounted as env vars at deploy; nothing in the repo.
- API service: public ingress but API-key gated; worker service: internal + Cloud Tasks OIDC only.
- Dedicated least-privilege service accounts per service (Firestore, GCS, Tasks enqueue only as needed).
- `webhookUrl` validated against SSRF (https only, no private/link-local ranges).

## 14. CI/CD and environments

- GitHub Actions: on PR — typecheck, lint, unit tests (parser fixtures); on merge to `main` — build Docker image → Artifact Registry → deploy both Cloud Run services with `--tag` revisions and instant rollback.
- `infra/` holds Terraform (or an idempotent `gcloud` setup script) for: Firestore, Tasks queue, GCS bucket, Secret Manager entries, log-based metrics, alert policies, budget. One command bootstraps a fresh project.
- Single environment to start (personal project); `dev` can be a second GCP project later using the same Terraform.

## 15. Cost expectations (order of magnitude — verify in Phase 0)

| Item | Estimate |
|---|---|
| Bright Data Web Unlocker | Billed per successful request (~$1–3 / 1,000 typical; **confirm shein.co.uk's rate** — premium domains cost more). 500 requests/day ≈ 15k/mo ≈ $15–45/mo at the default budget cap; scale the cap to taste. |
| Cloud Run (2 services, scale-to-zero) | ~$0–5/mo at personal volume |
| Cloud Tasks / Firestore / GCS / Secret Manager | Within free tier or ~$1–5/mo |
| **Driver of total cost** | The unlocker — which is why every guardrail in §5.4 targets request count. |

## 16. Implementation phases

**Phase 0 — Recon and verification (no code that matters yet)**
Manually capture (browser devtools + a handful of paid unlocker calls): a product page's `gbRawData` (confirm structure, currency field, per-size stock map), the reviews JSON endpoint and its parameters, the search/category grid JSON, the currency-forcing mechanism, whether non-rendered fetches include the blob, and Bright Data's current integration mode + per-request pricing for shein.co.uk. Save everything as test fixtures. **Exit criteria:** documented endpoint notes + fixtures committed.

**Phase 1 — Parsers (pure functions, fixture-tested)**
`gbRawData` extractor (brace-matching), product parser, search/category parser, reviews parser, Zod schemas, block/drift classifier. **Exit:** all fixtures parse to valid `Product`/`Review` documents; drift fixtures classified correctly.

**Phase 2 — Fetch layer**
Bright Data client (proxy mode), GB/GBP pinning, render-retry policy, budget ledger, canonicalization, structured logging. **Exit:** CLI script scrapes one product URL end-to-end to JSON for pennies.

**Phase 3 — Jobs, queue, storage**
Firestore repositories, Cloud Tasks integration, idempotent task handlers, fan-out for search/category, caching. **Exit:** a category job for ~30 products completes with partial-failure semantics intact.

**Phase 4 — API surface**
Fastify app, auth + rate limiting, the §8 endpoints, idempotency keys, OpenAPI generation, webhooks. **Exit:** full flow via HTTP only.

**Phase 5 — GCP deployment**
Dockerfiles, Terraform/bootstrap script, GitHub Actions deploy, service accounts, Secret Manager wiring, smoke test in the cloud. **Exit:** public (key-gated) API live on Cloud Run.

**Phase 6 — Hardening and observability**
Log-based metrics, dashboards, alert policies, budget alerts, weekly canary job, image mirroring (optional flag), load test a 200-product job within budget. **Exit:** alerts verified by deliberately breaking a fixture/canary.

**Phase 7 (optional, later) — LLM fallback parser**
Only if drift becomes frequent: a feature-flagged fallback that sends a *stripped* page (scripts/styles removed, image URLs pre-extracted) to an LLM with the same Zod schema as the output contract, used solely when the deterministic parser reports drift, with per-day call caps. Explicitly out of v1.

## 17. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Shein restructures `gbRawData` / review endpoint | Structural (not path-based) node search, fixture tests, drift alerts, weekly canary; worst case the parser is one module to rewrite. |
| Bright Data classifies shein.co.uk as premium / raises price | Per-request billing + ledger caps bound the damage; abstract the fetch client so Zyte/Oxylabs Web Unblocker are drop-in alternates. |
| Unlocker success rate drops | Block-rate alert fires early; Cloud Tasks backoff absorbs transient dips; provider competition is the long-term lever. |
| Runaway bulk job | maxProducts hard cap, dispatch rate cap, daily ledger, zone spend cap, budget alerts — five independent fuses. |
| Stale prices served from cache | Short 6 h TTL, `freshness: force` escape hatch, `scrapedAt` always returned so the caller can judge. |

## 18. Legal note

Shein's ToS prohibits scraping; review text and images carry user/brand rights, and storing reviewer-attributable data has GDPR implications. As a personal project the practical exposure is low, but keep the dataset private, don't redistribute images/reviews, and prefer storing review text without usernames.
