# Handoff — shein-scraper-api

**Updated:** 2026-06-11 · **For:** the next AI agent or human picking this up.
Quick orientation lives in [AGENTS.md](AGENTS.md); ops in [docs/DEPLOY.md](docs/DEPLOY.md);
full design in [docs/PLAN.md](docs/PLAN.md). This file is the current *status*.

**Immediate pending item:** confirming the end-to-end live scrape. Deployment is
green; the last fix granted the Cloud Tasks service agent `serviceAccountTokenCreator`
so the worker stops returning `403`. Verify a `POST /v1/jobs` product scrape runs
to a terminal state against the live API, then proceed to Phase 0 fixture capture.

## What this project is

A personal API that scrapes SHEIN UK product data (GBP) into structured JSON.
Key decisions, made deliberately and not to be relitigated without new information:

- **No LLM extraction.** Shein server-renders its full product state as an embedded
  `gbRawData = {...}` JSON blob; we parse it deterministically. Gemini was in an
  early draft and was cut (cost, latency, hallucination risk, lossy reviews).
  An LLM fallback is a feature-flagged Phase 7 option only.
- **Bright Data Web Unlocker** (direct-API mode) handles all anti-bot work — no
  headless browsers, no stealth plugins, no proxy rotation code anywhere.
- **GBP/UK pinned and fail-closed**: UK host forced, zone geo `country=gb`, and the
  parser throws `WrongCurrencyError` on any non-£ price rather than storing it.
- **Cost guardrails are layered**: no JS rendering unless the plain fetch lacks the
  blob → in-code daily budget ledger → Cloud Tasks dispatch-rate caps → Bright Data
  zone spend cap → GCP budget alerts. Images are never fetched through the unlocker.
- **GCP, not Railway**: Cloud Run (API + worker, scale-to-zero) + Cloud Tasks (queue,
  no Redis) + Firestore (no always-on Postgres) + Secret Manager.
- **Everything is async**: `POST /v1/jobs` → 202 + jobId → poll/paginate results.
  Partial success (`completed_with_errors`) is a first-class job state.

Full design rationale: `docs/PLAN.md` (§2 maps every critique of the original
draft to its resolution). The README has quickstart commands.

## Current state

Phases 1–5 are **done**. `npm run typecheck` clean, `npm test` → **28/28**
passing (4 files), `npm run build` produces `dist/`. **The service is deployed
and live on GCP Cloud Run** (see Deployment below).

| Area | State |
|---|---|
| `src/parse/` | Product, search/category grid, block-vs-drift classifier — done, fixture-tested. `reviews.ts` is a **stub** (field mapping unverified). |
| `src/fetch/` | Bright Data client, budget ledger (memory + Firestore), URL canonicalization — done. Request body verified against live docs: `{zone,url,format:"raw",country:"gb"}`; **no `render` field** (Web Unlocker auto-renders). |
| `src/store/` | Memory + Firestore repos behind one interface — done. Firestore now runs in production. |
| `src/worker/` | Task handlers, fan-out, cache-first, idempotent settling, finalization — done. **Cloud Tasks OIDC auth implemented** (enqueuer attaches `oidcToken`; worker re-verifies signature+audience+caller in `server.ts`). |
| `src/api/` | Auth, jobs CRUD, paginated results, Idempotency-Key — done. |
| `infra/setup.sh` | **Run and proven.** Idempotent; provisions APIs, Firestore, Artifact Registry, queue, SAs, secrets, log-metrics, WIF, and all the non-obvious IAM (see Deployment). |
| `.github/workflows/` | `ci.yml` (test on PR) + `deploy.yml` (build one image → deploy worker + API to Cloud Run via WIF) — both working. |

## Deployment (live)

- **API (public, `X-API-Key`):** `https://shein-api-642016941888.europe-west2.run.app`
- **Worker (private, OIDC):** `https://shein-worker-pagrcty3fa-nw.a.run.app`
- **Project** `project-784bd684-5270-421b-bb2` · **region** `europe-west2`.
- **`main` is the deploy branch** — pushing to it, or running the *Deploy to
  Cloud Run* Action, deploys. Config in GitHub repo **Variables**; secret values
  in **Secret Manager**. Auth is keyless **Workload Identity Federation**.
- Full runbook + a **troubleshooting table of every failure we hit** (WIF
  propagation, `iamcredentials` API, `secretmanager.secretAccessor`, the Cloud
  Tasks service-agent `serviceAccountTokenCreator`, Docker access-token login,
  and the project-id/number typos): [docs/DEPLOY.md](docs/DEPLOY.md). All of
  those IAM bits are now baked into `infra/setup.sh`.

> The original "import from thapsus-store" first task is **done** — this repo is
> the standalone home, `main` is canonical, code is self-contained.

## Next milestone: Phase 0 recon — capture real fixtures (CURRENT FOCUS)

The parsers are still pinned by *synthetic* fixtures
(`test/fixtures/make-fixtures.ts`). Now that the service is live, validate
against reality and replace them. **Network note:** the Claude web sandbox has
no egress to Bright Data — run live scrapes against the **deployed API** (or in
GCP Cloud Shell), not from the agent container.

1. ✅ Web Unlocker zone is `shein_scrapper` (GB, spend cap). Ensure `shein.co.uk`
   is on the zone's **domain allowlist** (a missing allowlist returns
   `Host not in allowlist`).
2. Drive a live product scrape end-to-end via the deployed API (`POST /v1/jobs`
   → poll → `/results`) and watch Cloud Run **Logs Explorer** for `unlocker_fetch`
   / `item_failed` events — fastest way to spot assumption-vs-reality drift.
3. ✅ Bright Data request fields verified (see `src/fetch/brightdata.ts`).
4. Capture & sanitize real fixtures: product page (multi-colour/size), search
   page, category page, and **the reviews JSON endpoint** (devtools on a product
   page's review section — paginated, keyed by goods_id/goods_sn). Commit them,
   update `src/parse/reviews.ts`, and wire the reviews task into
   `handleScrapeProduct` (TODO marker is there).
5. Confirm the currency-forcing mechanism and that a plain fetch reliably
   includes `gbRawData`.

## Known gaps / deliberate TODOs (all marked in code)

- Reviews: parser stub + no task handler wiring (blocked on Phase 0 fixtures).
- Webhooks: `options.webhookUrl` is accepted and stored but delivery is not
  implemented (TODO in `maybeFinalize`); needs HMAC signing + SSRF validation per PLAN §8.3/§13.
- ✅ Worker auth: **done** — Cloud Tasks OIDC (token signed as the invoker SA,
  audience = worker URL) verified at the Cloud Run edge *and* re-verified in-app
  (`server.ts`). `TASK_SECRET` remains as optional defence-in-depth.
- Per-key rate limiting: not implemented (auth is key-validation only).
- Image mirroring to GCS: not implemented (PLAN §10; URLs are stored, which is the default anyway).
- Inline-queue caveat (dev only): a `BlockedError` in inline mode is logged but
  the item never settles as `blocked` — that settling path runs in the worker
  server via the Cloud Tasks retry-count header (`MAX_TASK_ATTEMPTS`, keep in
  sync with queue config in `infra/setup.sh`).
- `GET /v1/products/:goodsId?refresh=true` from the plan is not implemented.

## Conventions to preserve

- Money is **integer pence** + `currency: "GBP"` literal. Never floats.
- Parsers navigate gbRawData by **structural node search** (`deepFind` on
  identifying key shapes), never hardcoded paths — that's the drift defence.
- Every stored document carries `schemaVersion` + `parserVersion` + `scrapedAt`.
- Fail loud: drift/wrong-currency are non-retryable, logged with `event` fields
  that feed the log-based metrics in `infra/setup.sh`; blocked is retryable.
- One language (TypeScript/ESM/Node 22), `.js` extensions on relative imports.
- Data stays private — Shein ToS prohibits scraping; don't redistribute (PLAN §18).
