#!/usr/bin/env bash
# Idempotent GCP bootstrap for the Shein scraper API (run with an owner account).
# Usage: PROJECT_ID=my-project ./infra/setup.sh
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-europe-west2}"   # London — keeps data UK-side
QUEUE="shein-scrape"
REPO="shein-scraper"

gcloud config set project "$PROJECT_ID"

# ── APIs ──────────────────────────────────────────────────────────────────────
gcloud services enable \
  run.googleapis.com cloudtasks.googleapis.com firestore.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com \
  iamcredentials.googleapis.com \
  monitoring.googleapis.com logging.googleapis.com

# ── Firestore (Native mode) ───────────────────────────────────────────────────
gcloud firestore databases create --location="$REGION" --type=firestore-native 2>/dev/null \
  || echo "firestore already exists"

# ── Artifact Registry ─────────────────────────────────────────────────────────
gcloud artifacts repositories create "$REPO" --repository-format=docker \
  --location="$REGION" 2>/dev/null || echo "artifact repo already exists"

# ── Cloud Tasks queue: retry/backoff + the dispatch-rate spend throttle ──────
gcloud tasks queues create "$QUEUE" --location="$REGION" 2>/dev/null || true
gcloud tasks queues update "$QUEUE" --location="$REGION" \
  --max-dispatches-per-second=2 \
  --max-concurrent-dispatches=4 \
  --max-attempts=4 \
  --min-backoff=30s --max-backoff=600s

# ── Service accounts (least privilege) ────────────────────────────────────────
for SA in shein-api shein-worker; do
  gcloud iam service-accounts create "$SA" 2>/dev/null || true
done
API_SA="shein-api@${PROJECT_ID}.iam.gserviceaccount.com"
WORKER_SA="shein-worker@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$API_SA" \
  --role=roles/datastore.user --condition=None -q
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$API_SA" \
  --role=roles/cloudtasks.enqueuer --condition=None -q
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$WORKER_SA" \
  --role=roles/datastore.user --condition=None -q
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$WORKER_SA" \
  --role=roles/cloudtasks.enqueuer --condition=None -q

# Both runtime SAs read their config from Secret Manager (mounted by Cloud Run),
# so they need accessor on the secrets — otherwise `gcloud run deploy` fails.
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$API_SA" \
  --role=roles/secretmanager.secretAccessor --condition=None -q
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$WORKER_SA" \
  --role=roles/secretmanager.secretAccessor --condition=None -q

# Cloud Tasks signs each worker push as an OIDC token for $API_SA, so $API_SA
# must be able to act as itself (the run.invoker binding on the worker service
# is granted by the deploy workflow, once the service exists).
gcloud iam service-accounts add-iam-policy-binding "$API_SA" \
  --member="serviceAccount:$API_SA" --role=roles/iam.serviceAccountUser -q

# ── GitHub Actions deploy via Workload Identity Federation (keyless) ───────────
# Set GH_REPO=owner/name to wire the OIDC trust to your repository.
GH_REPO="${GH_REPO:-}"
DEPLOY_SA="github-deployer@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud iam service-accounts create github-deployer 2>/dev/null || true
for ROLE in roles/run.admin roles/artifactregistry.writer roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$DEPLOY_SA" --role="$ROLE" --condition=None -q
done
gcloud iam workload-identity-pools create github --location=global \
  --display-name="GitHub Actions" 2>/dev/null || echo "WIF pool 'github' already exists"
POOL_ID="$(gcloud iam workload-identity-pools describe github --location=global --format='value(name)')"
# Create the OIDC provider only if missing — and DON'T swallow the error if the
# create fails, since a silently-missing provider breaks the whole GitHub→GCP
# token exchange (the deploy then fails with "invalid_target … doesn't exist").
if ! gcloud iam workload-identity-pools providers describe github \
      --location=global --workload-identity-pool=github >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc github \
    --location=global --workload-identity-pool=github \
    --display-name="GitHub OIDC" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository=='${GH_REPO}'" \
    --issuer-uri="https://token.actions.githubusercontent.com"
fi
if [[ -n "$GH_REPO" ]]; then
  gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
    --role=roles/iam.workloadIdentityUser \
    --member="principalSet://iam.googleapis.com/${POOL_ID}/attribute.repository/${GH_REPO}" -q
fi
PROVIDER="${POOL_ID}/providers/github"

# ── Secrets (create empty; fill via `gcloud secrets versions add`) ────────────
for S in brightdata-api-token api-keys task-secret; do
  gcloud secrets create "$S" --replication-policy=automatic 2>/dev/null || true
done

# ── Log-based metrics for the dashboard/alerts ────────────────────────────────
gcloud logging metrics create scrape_blocked \
  --description="Unlocker fetches classified as blocked" \
  --log-filter='jsonPayload.event="unlocker_fetch" AND jsonPayload.outcome="error"' 2>/dev/null || true
gcloud logging metrics create schema_drift \
  --description="Items failed with parse/drift errors" \
  --log-filter='jsonPayload.event="item_failed" AND jsonPayload.kind="parse_error"' 2>/dev/null || true

cat <<EOF

Bootstrap done. Next steps:
 1. Add secret values (one-off, kept out of git/GitHub):
      printf '%s' "\$TOKEN" | gcloud secrets versions add brightdata-api-token --data-file=-
      printf '%s' "\$KEYS"  | gcloud secrets versions add api-keys           --data-file=-   # comma-separated
      head -c 32 /dev/urandom | base64 | gcloud secrets versions add task-secret --data-file=-
 2. Set these GitHub repository *Variables* (Settings → Secrets and variables → Actions):
      GCP_PROJECT=$PROJECT_ID
      GCP_REGION=$REGION
      GCP_WIF_PROVIDER=$PROVIDER
      GCP_DEPLOY_SA=$DEPLOY_SA
      API_SERVICE_ACCOUNT=$API_SA
      WORKER_SERVICE_ACCOUNT=$WORKER_SA
 3. Run the "Deploy to Cloud Run" workflow (Actions tab → Run workflow). It
    builds the image and deploys worker + API; OIDC worker auth is in-app.
 4. Create alert policies on the scrape_blocked / schema_drift metrics and a
    billing budget with 50/80/100% thresholds.
 5. In the Bright Data dashboard: zone 'shein_scrapper', country=gb, daily
    spend cap, and allowlist shein.co.uk on the zone.
EOF
