# AGENTS.md — orientation for AI agents (and humans)

Read this first, then [HANDOFF.md](HANDOFF.md) (current state) and
[docs/PLAN.md](docs/PLAN.md) (full design rationale). This file is the 60-second
version: what the project is, how to work on it, and the decisions not to relitigate.

## What this is

A personal API that scrapes **SHEIN UK** product data (GBP) into structured JSON.
Deterministic parsing of Shein's embedded `gbRawData` state — **no LLM**. Anti-bot
handled by **Bright Data Web Unlocker**. Async job model on **GCP**: Fastify API +
Cloud Run worker, Cloud Tasks queue, Firestore store. Deployed via GitHub Actions.

## Decisions — settled, don't relitigate without new information

- **No LLM extraction.** `gbRawData` is server-rendered JSON; parse it structurally.
  An LLM fallback is a feature-flagged *Phase 7* option only.
- **Bright Data Web Unlocker, direct-API mode.** No headless browsers, no stealth
  plugins, no proxy code. JS rendering is **automatic** — there is no `render` flag.
- **GBP/UK pinned, fail-closed.** UK host forced, zone `country=gb`; the parser
  throws `WrongCurrencyError` on any non-£ price rather than storing it.
- **Money is integer pence** + `currency: "GBP"` literal. Never floats.
- **Parsers navigate `gbRawData` by structural search** (`deepFind` on key shapes),
  never hardcoded paths — that's the drift defence. Drift/wrong-currency are
  non-retryable and logged; `blocked` is retryable.
- **GCP, not Railway.** Cloud Run (scale-to-zero) + Cloud Tasks (no Redis) +
  Firestore (no always-on Postgres) + Secret Manager.
- **Everything is async.** `POST /v1/jobs` → `202 {jobId}` → poll/paginate.
  `completed_with_errors` is a first-class job state.
- **TypeScript / ESM / Node 22**, `.js` extensions on relative imports.
- **Data stays private** — Shein ToS prohibits scraping; don't redistribute.

## Working on it

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # 28 tests, no network (vitest)
npm run build         # tsc -> dist/
npm run scrape -- "<shein product url>"   # one-off live scrape (needs BRIGHTDATA_API_TOKEN)
```

Local API with in-process queue + memory store: `npm run dev:api` (and
`npm run dev:worker`). Set `.env` from `.env.example`.

## Layout

| Path | What |
|---|---|
| `src/parse/` | Product / search-grid parsers, block-vs-drift classifier, money. `reviews.ts` is a **stub**. |
| `src/fetch/` | Bright Data client, budget ledger, URL canonicalization. |
| `src/store/` | Memory + Firestore repos behind one `Stores` interface. |
| `src/worker/` | Cloud Tasks handlers, fan-out, cache-first, OIDC-gated `/internal/tasks` server. |
| `src/api/` | Fastify app: auth, jobs CRUD, paginated results, idempotency. |
| `src/deps.ts` | Composition root — wires everything from `Config`. |
| `infra/setup.sh` | Idempotent GCP bootstrap (run with owner creds). |
| `.github/workflows/deploy.yml` | Build one image → deploy worker + API to Cloud Run (WIF). |

## Branch & deploy model

- **`main`** is the canonical/deploy branch. Pushing to it (or running the
  *Deploy to Cloud Run* workflow) deploys. Keep `main` green and complete.
- Config lives in **GitHub repo Variables** (`GCP_PROJECT`, `GCP_REGION`,
  `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA`, `API_SERVICE_ACCOUNT`,
  `WORKER_SERVICE_ACCOUNT`); secret *values* live in Secret Manager.
- Deploy auth is keyless (Workload Identity Federation). See
  [docs/DEPLOY.md](docs/DEPLOY.md) for setup + a troubleshooting table of every
  failure mode we hit (WIF propagation, `iamcredentials` API, `secretAccessor`,
  Cloud Tasks `tokenCreator`, Docker access-token login).

## Current focus

Deployment is **done and live**. The open work is **Phase 0**: replace the
synthetic fixtures with captured real SHEIN HTML, verify the reviews JSON
endpoint, and implement `src/parse/reviews.ts` + wire it into the worker. See
[HANDOFF.md](HANDOFF.md) for the precise next steps and known gaps.
