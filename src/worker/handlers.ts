import type { Fetcher } from "../fetch/brightdata.js";
import { canonicalSheinUrl, categoryPageUrl, extractGoodsId, searchUrl } from "../fetch/canonical.js";
import { classifyProductHtml } from "../parse/classify.js";
import { parseSheinGrid } from "../parse/search.js";
import { parseSheinProduct } from "../parse/product.js";
import { finalStatus, settledCount, type Job, type JobOptions } from "../schema/job.js";
import { BlockedError, BudgetExceededError, SchemaDriftError, WrongCurrencyError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import type { Stores } from "../store/repos.js";
import type { Enqueuer, TaskPayload } from "./tasks.js";

export interface WorkerDeps {
  stores: Stores;
  fetcher: Fetcher;
  enqueuer: Enqueuer;
  config: {
    PRODUCT_TTL_SECONDS: number;
    MAX_PRODUCTS_DEFAULT: number;
    MAX_PRODUCTS_HARD: number;
  };
}

function ttlFor(options: JobOptions, defaultTtl: number): number {
  if (options.freshness === "force") return 0;
  const m = /^max_age:(\d+)$/.exec(options.freshness);
  return m ? parseInt(m[1]!, 10) : defaultTtl;
}

/**
 * Fetch a product page: one plain attempt, then a single re-fetch if the blob
 * is missing. Web Unlocker renders JS automatically (no render flag), so the
 * retry is just a fresh unlocker attempt that may route past a transient block;
 * `render: true` here is only the telemetry marker for the missing-blob retry.
 */
async function fetchProductHtml(fetcher: Fetcher, url: string, jobId: string): Promise<string> {
  const plain = await fetcher.fetchHtml(url, { jobId });
  if (classifyProductHtml(plain).kind === "ok") return plain;
  logger.info({ event: "blob_missing_retry", url, jobId });
  return fetcher.fetchHtml(url, { render: true, jobId });
}

async function maybeFinalize(deps: WorkerDeps, jobId: string): Promise<void> {
  const job = await deps.stores.jobs.get(jobId);
  if (!job || !job.fanoutComplete) return;
  if (job.status === "completed" || job.status === "completed_with_errors" || job.status === "failed") return;
  if (settledCount(job) < job.counts.discovered) return;
  await deps.stores.jobs.setStatus(jobId, finalStatus(job), true);
  logger.info({ event: "job_finished", jobId, status: finalStatus(job), counts: job.counts });
  // TODO(webhooks): enqueue deliver_webhook task here when options.webhookUrl is set.
}

export async function handleScrapeProduct(
  deps: WorkerDeps,
  payload: Extract<TaskPayload, { type: "scrape_product" }>,
): Promise<void> {
  const { jobId, options } = payload;
  const { jobs, products } = deps.stores;

  const job = await jobs.get(jobId);
  if (!job) return; // job deleted — drop silently
  if (job.status === "queued") await jobs.setStatus(jobId, "running");

  let url: string;
  let goodsId: string | null;
  try {
    url = canonicalSheinUrl(payload.url);
    goodsId = extractGoodsId(url);
    if (!goodsId) throw new Error("no goods_id in URL");
  } catch (err) {
    if (await jobs.trySettleItem(jobId, payload.url, "parse_error")) {
      await jobs.addError(jobId, payload.url, "invalid_url", String(err));
    }
    return maybeFinalize(deps, jobId);
  }
  const itemKey = `product:${goodsId}`;

  // Cache-first: a fresh snapshot costs zero unlocker calls.
  const ttl = ttlFor(options, deps.config.PRODUCT_TTL_SECONDS);
  if (ttl > 0) {
    const cached = await products.getFresh(goodsId, ttl);
    if (cached) {
      if (await jobs.trySettleItem(jobId, itemKey, "cached")) {
        await jobs.addResult(jobId, goodsId);
      }
      return maybeFinalize(deps, jobId);
    }
  }

  try {
    const html = await fetchProductHtml(deps.fetcher, url, jobId);
    const cls = classifyProductHtml(html);
    if (cls.kind === "blocked") throw new BlockedError(cls.reason);
    if (cls.kind === "drift") throw new SchemaDriftError(cls.reason);

    const product = parseSheinProduct(html, url);
    await products.upsert(product);
    if (await jobs.trySettleItem(jobId, itemKey, "succeeded")) {
      // Keyed by the parsed goodsId (not the URL-derived one) so results
      // always resolve in the products store.
      await jobs.addResult(jobId, product.goodsId);
    }
    // TODO(reviews): when options.includeReviews, enqueue fetch_reviews_page
    // tasks here once the Phase 0 reviews endpoint fixture is captured.
  } catch (err) {
    if (err instanceof BlockedError) {
      // Retryable: rethrow so Cloud Tasks redelivers with backoff. Only after
      // the queue exhausts attempts does the item settle as blocked — that
      // happens via the worker server's final-attempt header check.
      throw err;
    }
    const kind =
      err instanceof WrongCurrencyError ? "wrong_currency"
      : err instanceof SchemaDriftError ? "parse_error"
      : err instanceof BudgetExceededError ? "budget_exceeded"
      : "internal";
    logger.warn({ event: "item_failed", jobId, url, kind, error: String(err) });
    if (await jobs.trySettleItem(jobId, itemKey, "parse_error")) {
      await jobs.addError(jobId, url, kind, err instanceof Error ? err.message : String(err));
    }
  }
  return maybeFinalize(deps, jobId);
}

/** Called by the worker server when Cloud Tasks signals the final delivery attempt. */
export async function settleBlockedItem(
  deps: WorkerDeps,
  payload: Extract<TaskPayload, { type: "scrape_product" }>,
  reason: string,
): Promise<void> {
  const goodsId = extractGoodsId(payload.url) ?? payload.url;
  if (await deps.stores.jobs.trySettleItem(payload.jobId, `product:${goodsId}`, "blocked")) {
    await deps.stores.jobs.addError(payload.jobId, payload.url, "blocked", reason);
  }
  await maybeFinalize(deps, payload.jobId);
}

export async function handleScrapeGridPage(
  deps: WorkerDeps,
  payload: Extract<TaskPayload, { type: "scrape_grid_page" }>,
): Promise<void> {
  const { jobId, options } = payload;
  const { jobs } = deps.stores;
  const job = await jobs.get(jobId);
  if (!job) return;
  if (job.status === "queued") await jobs.setStatus(jobId, "running");

  const maxProducts = Math.min(
    options.maxProducts ?? deps.config.MAX_PRODUCTS_DEFAULT,
    deps.config.MAX_PRODUCTS_HARD,
  );

  const pageUrl =
    payload.kind === "search"
      ? searchUrl(payload.query ?? "", payload.page)
      : categoryPageUrl(payload.url ?? "", payload.page);

  const finishFanout = async (j: Job | null) => {
    await jobs.markFanoutComplete(jobId);
    if (j && j.counts.discovered === 0) {
      await jobs.setStatus(jobId, "completed", true); // empty result set is a valid outcome
    } else {
      await maybeFinalize(deps, jobId);
    }
  };

  try {
    const html = await fetchProductHtml(deps.fetcher, pageUrl, jobId);
    const cls = classifyProductHtml(html);
    if (cls.kind === "blocked") throw new BlockedError(cls.reason);

    const discovered = parseSheinGrid(html);
    const room = maxProducts - payload.enqueuedSoFar;
    const batch = discovered.slice(0, Math.max(0, room));

    if (batch.length > 0) {
      await jobs.addDiscovered(jobId, batch.length);
      for (const item of batch) {
        await deps.enqueuer.enqueue({ type: "scrape_product", jobId, url: item.url, options });
      }
    }

    const exhausted = discovered.length === 0; // empty grid page = end of results
    const full = payload.enqueuedSoFar + batch.length >= maxProducts;
    if (exhausted || full) {
      await finishFanout(await jobs.get(jobId));
    } else {
      await deps.enqueuer.enqueue({
        ...payload,
        page: payload.page + 1,
        enqueuedSoFar: payload.enqueuedSoFar + batch.length,
      });
    }
  } catch (err) {
    if (err instanceof BlockedError) throw err; // let the queue retry the page
    logger.warn({ event: "grid_page_failed", jobId, pageUrl, error: String(err) });
    await jobs.addError(jobId, pageUrl, err instanceof SchemaDriftError ? "parse_error" : "internal",
      err instanceof Error ? err.message : String(err));
    await finishFanout(await jobs.get(jobId)); // stop fan-out; settled items still finalize
  }
}

export async function dispatchTask(deps: WorkerDeps, payload: TaskPayload): Promise<void> {
  switch (payload.type) {
    case "scrape_product":
      return handleScrapeProduct(deps, payload);
    case "scrape_grid_page":
      return handleScrapeGridPage(deps, payload);
  }
}
