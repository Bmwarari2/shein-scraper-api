import { describe, expect, it } from "vitest";
import { createMemoryStores } from "../src/store/memory.js";
import { type WorkerDeps } from "../src/worker/handlers.js";
import { InlineEnqueuer } from "../src/worker/tasks.js";
import { buildWorkerServer } from "../src/worker/server.js";

function buildWorker(opts: Parameters<typeof buildWorkerServer>[1]) {
  const stores = createMemoryStores();
  const deps: WorkerDeps = {
    stores,
    fetcher: { fetchHtml: async () => "" },
    enqueuer: new InlineEnqueuer(),
    config: { PRODUCT_TTL_SECONDS: 3600, MAX_PRODUCTS_DEFAULT: 50, MAX_PRODUCTS_HARD: 500 },
  };
  return buildWorkerServer(deps, opts);
}

const payload = {
  type: "scrape_product",
  jobId: "j1",
  url: "https://www.shein.co.uk/X-p-12345678.html",
  options: {},
};

describe("worker task auth", () => {
  it("rejects a task push with no OIDC bearer token when oidc is required", async () => {
    const app = buildWorker({ oidc: { audience: "https://worker.example" } });
    const res = await app.inject({
      method: "POST",
      url: "/internal/tasks",
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a malformed bearer token", async () => {
    const app = buildWorker({ oidc: { audience: "https://worker.example" } });
    const res = await app.inject({
      method: "POST",
      url: "/internal/tasks",
      headers: { "content-type": "application/json", authorization: "Bearer not-a-jwt" },
      payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a wrong shared secret when no oidc is configured", async () => {
    const app = buildWorker({ taskSecret: "s3cret" });
    const res = await app.inject({
      method: "POST",
      url: "/internal/tasks",
      headers: { "content-type": "application/json", "x-task-secret": "wrong" },
      payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a correct shared secret when no oidc is configured", async () => {
    const app = buildWorker({ taskSecret: "s3cret" });
    const res = await app.inject({
      method: "POST",
      url: "/internal/tasks",
      headers: { "content-type": "application/json", "x-task-secret": "s3cret" },
      payload,
    });
    expect(res.statusCode).not.toBe(401);
  });
});
