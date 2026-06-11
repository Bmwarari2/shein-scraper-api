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

   The script also wires the non-obvious IAM the deploy needs (all learned the
   hard way — see Troubleshooting): the `iamcredentials` API, `secretAccessor`
   for the runtime SAs, the API SA's `serviceAccountUser` on itself, and the
   **Cloud Tasks service agent's `serviceAccountTokenCreator`** on the API SA.
   Newly-created WIF providers can take a few minutes to propagate before the
   first deploy authenticates.

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

## Troubleshooting (every wall the first deploy hit)

Read the failing GitHub Actions step's log; the error almost always names the
fix. These are the ones that bit us, in the order they surface:

| Symptom (in the deploy log or at runtime) | Cause & fix |
|---|---|
| `auth failed … must specify exactly one of "workload_identity_provider"` | The 6 GitHub **Variables** aren't set yet. Set them, re-run. |
| `invalid_target … pool or provider … doesn't exist` | `GCP_WIF_PROVIDER` has the wrong **project number** or a typo (`workloadIdentityP0ols`), or the provider is still propagating. Match it exactly to `gcloud iam workload-identity-pools providers describe github --location=global --workload-identity-pool=github --format='value(name)'`. |
| `denied … artifactregistry.repositories.uploadArtifacts … (or it may not exist)` | Wrong **project ID** in `GCP_PROJECT`/SA variables, so the image targets a project that isn't yours. Verify with `gcloud projects list --filter="projectNumber=<num>" --format='value(projectId)'`. |
| `IAM Service Account Credentials API has not been used … or it is disabled` | `gcloud services enable iamcredentials.googleapis.com` (now in `setup.sh`). |
| `Permission denied on secret … secretmanager.secretAccessor` | Runtime SAs need `roles/secretmanager.secretAccessor` (now in `setup.sh`). |
| Job stuck at `status: queued`; worker logs show `POST 403 /internal/tasks` and **no app logs** | Cloud Tasks can't mint the worker's OIDC token. Grant the Cloud Tasks service agent `serviceAccountTokenCreator` on the API SA (now in `setup.sh`). The `403` is at the Cloud Run edge, not the app. |
| Worker logs show a `401` / `task_auth_rejected` (app-level) | The OIDC audience or invoker email is wrong: the API's `WORKER_URL` env must equal the worker's real URL, and `TASKS_INVOKER_SA` must hold `run.invoker` on the worker (the deploy grants this). |
| Live scrape returns `blocked` / `Host not in allowlist` | Bright Data zone, not GCP: add `shein.co.uk` to the `shein_scrapper` zone allowlist and confirm `country=gb`. |

Re-running `infra/setup.sh` is safe (idempotent) and now applies all of the IAM
above; most fixes are just "re-run setup.sh, then re-run the deploy workflow."

## Live deployment (this project)

- **API (public):** `https://shein-api-642016941888.europe-west2.run.app`
- **Worker (private):** `https://shein-worker-pagrcty3fa-nw.a.run.app`
- **Project:** `project-784bd684-5270-421b-bb2` · **Region:** `europe-west2`
