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

Bootstrap done. Next steps (manual):
 1. Add secret values:
      printf '%s' "\$TOKEN" | gcloud secrets versions add brightdata-api-token --data-file=-
 2. Build & push the image, then deploy two Cloud Run services from it:
      shein-api:    command 'node dist/api/main.js',    public ingress, SA $API_SA
      shein-worker: command 'node dist/worker/main.js', internal ingress, SA $WORKER_SA
    Env: STORE_MODE=firestore QUEUE_MODE=cloud_tasks GCP_PROJECT=$PROJECT_ID
         TASKS_LOCATION=$REGION TASKS_QUEUE=$QUEUE WORKER_URL=<worker url>
    Secrets: BRIGHTDATA_API_TOKEN, API_KEYS, TASK_SECRET.
 3. Switch worker auth to Cloud Tasks OIDC (oidcToken on tasks + audience check).
 4. Create alert policies on the scrape_blocked / schema_drift metrics and a
    billing budget with 50/80/100% thresholds.
 5. In the Bright Data dashboard: zone 'shein_uk', country=gb, daily spend cap.
EOF
