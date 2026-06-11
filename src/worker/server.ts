import Fastify from "fastify";
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
 * ingress internal + OIDC-authenticated pushes. The shared-secret header is
 * a defence-in-depth check, not the primary control.
 */

const MAX_TASK_ATTEMPTS = 4; // keep in sync with the queue's maxAttempts in infra/

// Return type inferred (see buildApiServer note on pino/Fastify generics).
export function buildWorkerServer(deps: WorkerDeps, opts: { taskSecret?: string } = {}) {
  const app = Fastify({ loggerInstance: logger.child({ service: "worker" }) });

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/internal/tasks", async (req, reply) => {
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
