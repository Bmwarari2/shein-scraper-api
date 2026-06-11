import { describe, expect, it } from "vitest";
import { buildApiServer } from "../src/api/server.js";
import type { Fetcher } from "../src/fetch/brightdata.js";
import { createMemoryStores } from "../src/store/memory.js";
import { dispatchTask, type WorkerDeps } from "../src/worker/handlers.js";
import { InlineEnqueuer } from "../src/worker/tasks.js";
import { blockedPageHtml, productPageHtml, searchPageHtml, emptyGridPageHtml } from "./fixtures/make-fixtures.js";

const API_KEY = "test-key-123";

function buildApp(fetchHtml: Fetcher["fetchHtml"]) {
  const stores = createMemoryStores();
  const enqueuer = new InlineEnqueuer();
  const deps: WorkerDeps = {
    stores,
    fetcher: { fetchHtml },
    enqueuer,
    config: { PRODUCT_TTL_SECONDS: 3600, MAX_PRODUCTS_DEFAULT: 50, MAX_PRODUCTS_HARD: 500 },
  };
  enqueuer.bind((p) => dispatchTask(deps, p));
  const app = buildApiServer({
    stores,
    enqueuer,
    apiKeys: [API_KEY],
    limits: { maxProductsDefault: 50, maxProductsHard: 500, maxReviewPagesDefault: 3 },
  });
  return { app, stores, deps };
}

const headers = { "x-api-key": API_KEY, "content-type": "application/json" };

async function waitForTerminal(app: ReturnType<typeof buildApp>["app"], jobId: string) {
  for (let i = 0; i < 50; i++) {
    const res = await app.inject({ method: "GET", url: `/v1/jobs/${jobId}`, headers });
    const job = res.json();
    if (["completed", "completed_with_errors", "failed"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("job never finished");
}

describe("end-to-end job flow (inline queue, memory store, fake fetcher)", () => {
  it("rejects requests without an API key", async () => {
    const { app } = buildApp(async () => productPageHtml());
    const res = await app.inject({
      method: "POST",
      url: "/v1/jobs",
      payload: { type: "product", url: "https://www.shein.co.uk/X-p-12345678.html" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("scrapes a single product job through to results", async () => {
    const { app } = buildApp(async () => productPageHtml());
    const create = await app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers,
      payload: { type: "product", url: "https://www.shein.co.uk/X-p-12345678.html?ref=ads" },
    });
    expect(create.statusCode).toBe(202);
    const { jobId } = create.json();

    const job = await waitForTerminal(app, jobId);
    expect(job.status).toBe("completed");
    expect(job.counts).toMatchObject({ discovered: 1, succeeded: 1 });

    const results = await app.inject({ method: "GET", url: `/v1/jobs/${jobId}/results`, headers });
    const body = results.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].goodsId).toBe("12345678");
    expect(body.items[0].price.amountPence).toBe(1108);

    const direct = await app.inject({ method: "GET", url: "/v1/products/12345678", headers });
    expect(direct.statusCode).toBe(200);
  });

  it("serves repeat scrapes from cache (no second fetch)", async () => {
    let fetches = 0;
    const { app } = buildApp(async () => {
      fetches++;
      return productPageHtml();
    });
    const run = async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers,
        payload: { type: "product", url: "https://www.shein.co.uk/X-p-12345678.html" },
      });
      return waitForTerminal(app, res.json().jobId);
    };
    await run();
    const second = await run();
    expect(fetches).toBe(1);
    expect(second.counts.cached).toBe(1);
  });

  it("fans out a search job and finishes on the empty page", async () => {
    const { app } = buildApp(async (url: string) => {
      if (url.includes("pdsearch")) {
        return url.includes("page=") ? emptyGridPageHtml() : searchPageHtml();
      }
      return productPageHtml();
    });
    const create = await app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers,
      payload: { type: "search", query: "floral midi dress" },
    });
    const job = await waitForTerminal(app, create.json().jobId);
    expect(job.status).toBe("completed");
    expect(job.counts.discovered).toBe(2);
    // both discovered URLs are scraped (distinct URL goods_ids → no cache hit)
    expect(job.counts.succeeded).toBe(2);
  });

  it("records parse_error (not retry-forever) on schema drift", async () => {
    const { app } = buildApp(async () => "<html><title>X | SHEIN</title>" + "x".repeat(3000) + "</html>");
    const create = await app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers,
      payload: { type: "product", url: "https://www.shein.co.uk/X-p-12345678.html" },
    });
    const job = await waitForTerminal(app, create.json().jobId);
    expect(job.status).toBe("failed");
    expect(job.counts.parseErrors).toBe(1);
    expect(job.errors[0].kind).toBe("parse_error");
  });

  it("honours Idempotency-Key", async () => {
    const { app } = buildApp(async () => productPageHtml());
    const payload = { type: "product", url: "https://www.shein.co.uk/X-p-12345678.html" };
    const h = { ...headers, "idempotency-key": "abc" };
    const first = await app.inject({ method: "POST", url: "/v1/jobs", headers: h, payload });
    const second = await app.inject({ method: "POST", url: "/v1/jobs", headers: h, payload });
    expect(second.json().jobId).toBe(first.json().jobId);
    expect(second.json().deduplicated).toBe(true);
  });

  it("validates job input shapes", async () => {
    const { app } = buildApp(async () => blockedPageHtml());
    const res = await app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers,
      payload: { type: "search" }, // missing query
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_INPUT");
  });
});
