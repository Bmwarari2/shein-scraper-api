import Fastify from "fastify";
import { OAuth2Client } from "google-auth-library";
import { BlockedError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { dispatchTask, settleBlockedItem, type WorkerDeps } from "./handlers.js";
import type { TaskPayload } from "./tasks.js";

/**
 * Worker service: receives Cloud Tasks HTTP pushes on /internal/tasks.
 * Response semantics drive the queue: 2xx = done (success OR permanently
 * settled failure), 5xx = redeliver with backoff.
 *
 * Deploy note: this service must NOT be publicly reachable — Cloud Run
 * ingress internal-and-cloud-load-balancing + `--no-allow-unauthenticated`.
 * Cloud Run validates the Cloud Tasks OIDC token at the edge; the in-app
 * check below re-verifies signature + audience + caller identity as
 * defence-in-depth. The shared secret is a tertiary belt-and-braces check.
 */

const MAX_TASK_ATTEMPTS = 4; // keep in sync with the queue's maxAttempts in infra/

// One shared verifier: caches Google's signing certs across requests.
const oauthClient = new OAuth2Client();

export interface WorkerAuthOptions {
  taskSecret?: string;
  /** When set, require a valid Google OIDC token on each task push. */
  oidc?: { audience: string; allowedEmails?: string[] };
}

/**
 * Verify the `Authorization: Bearer <id_token>` minted by Cloud Tasks:
 * Google signature, expiry, audience (the worker URL), and — if configured —
 * that the token was issued for the expected invoker SA. Returns null on
 * success or a short reason string on failure.
 */
async function verifyOidc(
  authHeader: string | undefined,
  oidc: { audience: string; allowedEmails?: string[] },
): Promise<string | null> {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return "missing bearer token";
  try {
    const ticket = await oauthClient.verifyIdToken({ idToken: token, audience: oidc.audience });
    const claims = ticket.getPayload();
    if (!claims?.email || claims.email_verified === false) return "unverified email claim";
    if (oidc.allowedEmails?.length && !oidc.allowedEmails.includes(claims.email)) {
      return "caller not allowed";
    }
    return null;
  } catch (err) {
    return `token verification failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// Return type inferred (see buildApiServer note on pino/Fastify generics).
export function buildWorkerServer(deps: WorkerDeps, opts: WorkerAuthOptions = {}) {
  const app = Fastify({ loggerInstance: logger.child({ service: "worker" }) });

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/internal/tasks", async (req, reply) => {
    if (opts.oidc) {
      const reason = await verifyOidc(req.headers.authorization, opts.oidc);
      if (reason) {
        req.log.warn({ event: "task_auth_rejected", reason });
        return reply.code(401).send({ error: "unauthorized" });
      }
    }
    if (opts.taskSecret && req.headers["x-task-secret"] !== opts.taskSecret) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const payload = req.body as TaskPayload;
    // Cloud Tasks counts prior dispatches; on the final allowed attempt a
    // still-blocked item settles as blocked instead of bouncing forever.
    const retryCount = Number(req.headers["x-cloudtasks-taskretrycount"] ?? 0);
    const finalAttempt = retryCount >= MAX_TASK_ATTEMPTS - 1;

    try {
      await dispatchTask(deps, payload);
      return reply.code(200).send({ ok: true });
    } catch (err) {
      if (err instanceof BlockedError) {
        if (finalAttempt && payload.type === "scrape_product") {
          await settleBlockedItem(deps, payload, err.reason);
          return reply.code(200).send({ ok: true, settled: "blocked" });
        }
        return reply.code(503).send({ retry: true, reason: err.reason });
      }
      req.log.error({ err, payload }, "task handler crashed");
      return reply.code(500).send({ retry: true });
    }
  });

  return app;
}
