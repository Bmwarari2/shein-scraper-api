# Deploying to Google Cloud

The app runs as two Cloud Run services built from one image:

- **shein-api** — public (Cloud Run IAM `--allow-unauthenticated`); the app
  enforces `X-API-Key` itself. Enqueues work to Cloud Tasks.
- **shein-worker** — not publicly invocable (`--no-allow-unauthenticated`).
  Receives Cloud Tasks pushes authenticated with a Google **OIDC token**, which
  Cloud Run validates at the edge *and* the worker re-verifies in-app
  (signature + audience + invoker SA). No shared secret is required (one is
  still supported as defence-in-depth via the `task-secret` secret).

Storage is Firestore (native mode); the queue is Cloud Tasks. No Redis, no
always-on Postgres. Region defaults to `europe-west2` (London) to keep data
UK-side.

## One-time setup

1. **Bootstrap the project** (owner credentials), wiring the GitHub OIDC trust:

   ```bash
   PROJECT_ID=my-shein-proj GH_REPO=Bmwarari2/shein-scraper-api ./infra/setup.sh
   ```

   This enables APIs and creates Firestore, Artifact Registry, the Cloud Tasks
   queue (with rate caps), the runtime service accounts, the empty secrets, the
   log-based metrics, and the Workload Identity Federation pool/provider + a
   `github-deployer` service account. It prints the exact GitHub variable
   values to paste in the next step.

2. **Add the secret values** (kept out of git and GitHub — they live only in
   Secret Manager):

   ```bash
   printf '%s' "$BRIGHTDATA_TOKEN" | gcloud secrets versions add brightdata-api-token --data-file=-
   printf '%s' "key1,key2"         | gcloud secrets versions add api-keys             --data-file=-
   head -c 32 /dev/urandom | base64 | gcloud secrets versions add task-secret          --data-file=-
   ```

3. **Set GitHub repository Variables** (Settings → Secrets and variables →
   Actions → Variables) to the values `setup.sh` printed:
   `GCP_PROJECT`, `GCP_REGION`, `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA`,
   `API_SERVICE_ACCOUNT`, `WORKER_SERVICE_ACCOUNT`.

4. **In the Bright Data dashboard**: ensure the `shein_scrapper` Web Unlocker
   zone has `country=gb`, a daily spend cap, and **shein.co.uk allowlisted**
   on the zone (the recon hit "Host not in allowlist" — add the domain).

## Deploy

Actions tab → **Deploy to Cloud Run** → Run workflow (also runs automatically on
push to `main`). It builds the image, deploys the worker, grants the API SA
`run.invoker` on it, then deploys the API. The run summary prints both URLs.

## Smoke test from the deployed API

```bash
API=https://shein-api-xxxx.a.run.app
KEY=<one of the API_KEYS you stored>

# Kick off a product scrape
curl -s -X POST "$API/v1/jobs" -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"type":"product","url":"https://www.shein.co.uk/...-p-38002952.html"}'
# → 202 {"jobId":"..."}

# Poll
curl -s "$API/v1/jobs/<jobId>" -H "X-API-Key: $KEY"
# Results (cursor-paginated)
curl -s "$API/v1/jobs/<jobId>/results" -H "X-API-Key: $KEY"
```

If a job settles `failed` with a `parse_error`/drift, the synthetic fixtures
have diverged from the live page — capture the real HTML (Logs Explorer shows
the `unlocker_fetch` events) and update the parsers/fixtures.
