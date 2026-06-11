# Session Handoff — shein-scraper-api

**Date:** 2026-06-11
**For:** the next Claude Code session (ideally started from the `Bmwarari2/shein-scraper-api` repo) or any human picking this up.

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

Phases 1–4 are **implemented and verified**: `npm run typecheck` clean,
`npm test` → 25/25 passing (3 files), `npm run build` produces `dist/`.

| Area | State |
|---|---|
| `src/parse/` | Product, search/category grid, block-vs-drift classifier — done, fixture-tested. `reviews.ts` is a **stub** (field mapping unverified). |
| `src/fetch/` | Bright Data client, budget ledger (memory + Firestore), URL canonicalization — done, **but request options unverified against live API** (see Phase 0). |
| `src/store/` | Memory + Firestore repos behind one interface — done. Firestore impl has never run against a real project. |
| `src/worker/` | Task handlers, fan-out, cache-first, idempotent settling, finalization — done. Inline + Cloud Tasks enqueuers. |
| `src/api/` | Auth, jobs CRUD, paginated results, Idempotency-Key — done. |
| `infra/setup.sh` | Written, never executed. |
| `.github/workflows/ci.yml` | Test job ready; deploy job is a commented sketch. |

## Repo situation (read this first)

The code currently lives in the `shein-scraper-api/` **subdirectory** of
`Bmwarari2/thapsus-store`, branch `claude/shein-scraper-api-plan-p08lit` —
only because the session that built it couldn't push anywhere else. The user
has created `Bmwarari2/shein-scraper-api` and granted the Claude app access.

**First task of the next session: import this directory's contents to the root
of `Bmwarari2/shein-scraper-api` as the initial commit** (then the user can
delete the thapsus-store branch). The project is fully self-contained — no
references to thapsus-store anywhere. Verify after import: `npm install && npm test`.

## Next milestone: Phase 0 recon (needs the user's Bright Data account)

The parsers are pinned by *synthetic* fixtures (`test/fixtures/make-fixtures.ts`)
that encode the expected gbRawData shape. Phase 0 replaces assumptions with
captured reality:

1. User creates a Web Unlocker zone `shein_uk` (country=GB, **daily spend cap**),
   puts token in `.env` as `BRIGHTDATA_API_TOKEN`.
2. Run `npm run scrape -- "<shein.co.uk product URL>"` — this exercises
   fetch → classify → parse end to end and is the fastest way to find drift
   between assumption and reality.
3. Verify against current Bright Data docs (knowledge may be stale):
   the `api.brightdata.com/request` body fields (`format`, `country`, `render`
   flag name) in `src/fetch/brightdata.ts`, and whether shein.co.uk is billed
   as a premium domain.
4. Capture real fixtures: product page (multi-colour, multi-size), search page,
   category page, **the reviews JSON endpoint** (find it in devtools on a product
   page's review section — paginated, keyed by goods_id/goods_sn). Sanitize and
   commit; update `src/parse/reviews.ts` mapping and wire the reviews task into
   `handleScrapeProduct` (TODO marker is there).
5. Confirm the currency-forcing mechanism (cookie/param) and whether the plain
   (non-rendered) fetch reliably includes gbRawData.

## Known gaps / deliberate TODOs (all marked in code)

- Reviews: parser stub + no task handler wiring (blocked on Phase 0 fixtures).
- Webhooks: `options.webhookUrl` is accepted and stored but delivery is not
  implemented (TODO in `maybeFinalize`); needs HMAC signing + SSRF validation per PLAN §8.3/§13.
- Worker auth: shared-secret header (`TASK_SECRET`) — must switch to Cloud Tasks
  OIDC tokens + audience verification before/at deploy (TODO in `tasks.ts`, `server.ts`).
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
