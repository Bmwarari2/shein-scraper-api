import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import { createJobBodySchema, resultsQuerySchema } from "../schema/api.js";
import { jobOptionsSchema, newJob } from "../schema/job.js";
import { ApiError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { canonicalSheinUrl, isProductUrl } from "../fetch/canonical.js";
import type { Stores } from "../store/repos.js";
import type { Enqueuer } from "../worker/tasks.js";

export interface ApiServerDeps {
  stores: Stores;
  enqueuer: Enqueuer;
  apiKeys: string[];
  limits: { maxProductsDefault: number; maxProductsHard: number; maxReviewPagesDefault: number };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();

function keyIdFor(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

// Return type inferred: pino's logger generics don't fit Fastify's default
// FastifyInstance parameters under exactOptionalPropertyTypes.
export function buildApiServer(deps: ApiServerDeps) {
  const app = Fastify({ loggerInstance: logger.child({ service: "api" }) });
  const keyHashes = deps.apiKeys.map(sha256);

  function authenticate(req: FastifyRequest): string {
    const presented = req.headers["x-api-key"];
    if (typeof presented === "string" && presented) {
      const h = sha256(presented);
      if (keyHashes.some((k) => timingSafeEqual(k, h))) return keyIdFor(presented);
    }
    throw new ApiError(401, "UNAUTHORIZED", "missing or invalid X-API-Key");
  }

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({
        error: { code: err.code, message: err.message, retryable: err.code === "RATE_LIMITED" },
      });
    }
    req.log.error({ err }, "unhandled API error");
    return reply.code(500).send({
      error: { code: "INTERNAL", message: "internal error", retryable: true },
    });
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/v1/jobs", async (req, reply) => {
    const apiKeyId = authenticate(req);

    const parsed = createJobBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_INPUT", parsed.error.issues.map((i) => i.message).join("; "));
    }
    const body = parsed.data;

    // Idempotency: same key returns the same job, no duplicate scraping spend.
    const idemKey = req.headers["idempotency-key"];
    if (typeof idemKey === "string" && idemKey) {
      const existing = await deps.stores.jobs.getJobIdForIdempotencyKey(`${apiKeyId}:${idemKey}`);
      if (existing) {
        const job = await deps.stores.jobs.get(existing);
        if (job) return reply.code(200).send({ jobId: job.jobId, status: job.status, deduplicated: true });
      }
    }

    const options = jobOptionsSchema.parse({
      ...body.options,
      maxProducts: Math.min(
        body.options.maxProducts ?? deps.limits.maxProductsDefault,
        deps.limits.maxProductsHard,
      ),
      maxReviewPages: body.options.maxReviewPages ?? deps.limits.maxReviewPagesDefault,
    });

    let canonicalUrl: string | undefined;
    if (body.url) {
      try {
        canonicalUrl = canonicalSheinUrl(body.url);
      } catch {
        throw new ApiError(400, "INVALID_INPUT", "url must be a shein.* URL");
      }
      if (body.type === "product" && !isProductUrl(canonicalUrl)) {
        throw new ApiError(400, "INVALID_INPUT", "url does not look like a Shein product page (-p-<id>.html)");
      }
    }

    const jobId = randomUUID();
    const isProduct = body.type === "product";
    const job = newJob({
      jobId,
      type: body.type,
      input: { ...(canonicalUrl ? { url: canonicalUrl } : {}), ...(body.query ? { query: body.query } : {}) },
      options,
      apiKeyId,
      discovered: isProduct ? 1 : 0,
      fanoutComplete: isProduct,
    });
    await deps.stores.jobs.create(job);

    if (typeof idemKey === "string" && idemKey) {
      await deps.stores.jobs.setIdempotencyKey(`${apiKeyId}:${idemKey}`, jobId);
    }

    if (body.type === "product") {
      await deps.enqueuer.enqueue({ type: "scrape_product", jobId, url: canonicalUrl!, options });
    } else {
      await deps.enqueuer.enqueue({
        type: "scrape_grid_page",
        jobId,
        kind: body.type,
        ...(body.query ? { query: body.query } : {}),
        ...(canonicalUrl ? { url: canonicalUrl } : {}),
        page: 1,
        enqueuedSoFar: 0,
        options,
      });
    }

    const estimatedRequests = isProduct
      ? 1
      : (options.maxProducts ?? deps.limits.maxProductsDefault) + 3; // grid pages on top
    return reply.code(202).send({ jobId, status: "queued", estimatedRequests });
  });

  app.get("/v1/jobs/:jobId", async (req) => {
    authenticate(req);
    const { jobId } = req.params as { jobId: string };
    const job = await deps.stores.jobs.get(jobId);
    if (!job) throw new ApiError(404, "NOT_FOUND", `job ${jobId} not found`);
    return job;
  });

  app.get("/v1/jobs/:jobId/results", async (req) => {
    authenticate(req);
    const { jobId } = req.params as { jobId: string };
    const q = resultsQuerySchema.parse(req.query ?? {});
    const job = await deps.stores.jobs.get(jobId);
    if (!job) throw new ApiError(404, "NOT_FOUND", `job ${jobId} not found`);

    const page = await deps.stores.jobs.listResults(jobId, q.cursor, q.limit);
    const items = (
      await Promise.all(page.goodsIds.map((id) => deps.stores.products.get(id)))
    ).filter((p) => p !== null);
    return { jobStatus: job.status, items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  });

  app.get("/v1/products/:goodsId", async (req) => {
    authenticate(req);
    const { goodsId } = req.params as { goodsId: string };
    const product = await deps.stores.products.get(goodsId);
    if (!product) throw new ApiError(404, "NOT_FOUND", `product ${goodsId} has never been scraped`);
    return product;
  });

  return app;
}
