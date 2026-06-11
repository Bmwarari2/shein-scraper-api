import type { Job, JobErrorKind, JobStatus } from "../schema/job.js";
import type { Product } from "../schema/product.js";
import type { ItemStatus, JobsRepo, ProductsRepo, Stores } from "./repos.js";

/** In-process store for local development and tests. Not durable by design. */

class MemoryProducts implements ProductsRepo {
  private byId = new Map<string, Product>();

  async get(goodsId: string): Promise<Product | null> {
    return this.byId.get(goodsId) ?? null;
  }

  async getFresh(goodsId: string, maxAgeSeconds: number): Promise<Product | null> {
    const p = this.byId.get(goodsId);
    if (!p) return null;
    const age = (Date.now() - Date.parse(p.scrapedAt)) / 1000;
    return age <= maxAgeSeconds ? p : null;
  }

  async upsert(product: Product): Promise<void> {
    this.byId.set(product.goodsId, product);
  }
}

class MemoryJobs implements JobsRepo {
  private jobs = new Map<string, Job>();
  private items = new Map<string, Map<string, ItemStatus>>();
  private results = new Map<string, string[]>();
  private idempotency = new Map<string, string>();

  private must(jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    return job;
  }

  async create(job: Job): Promise<void> {
    this.jobs.set(job.jobId, structuredClone(job));
    this.items.set(job.jobId, new Map());
    this.results.set(job.jobId, []);
  }

  async get(jobId: string): Promise<Job | null> {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : null;
  }

  async setStatus(jobId: string, status: JobStatus, finished = false): Promise<void> {
    const job = this.must(jobId);
    job.status = status;
    if (status === "running" && !job.startedAt) job.startedAt = new Date().toISOString();
    if (finished) job.finishedAt = new Date().toISOString();
  }

  async trySettleItem(jobId: string, itemKey: string, status: ItemStatus): Promise<boolean> {
    const items = this.items.get(jobId);
    if (!items || items.has(itemKey)) return false;
    items.set(itemKey, status);
    const job = this.must(jobId);
    if (status === "succeeded") job.counts.succeeded++;
    else if (status === "cached") job.counts.cached++;
    else if (status === "blocked") job.counts.blocked++;
    else job.counts.parseErrors++;
    return true;
  }

  async addDiscovered(jobId: string, count: number): Promise<void> {
    this.must(jobId).counts.discovered += count;
  }

  async markFanoutComplete(jobId: string): Promise<void> {
    this.must(jobId).fanoutComplete = true;
  }

  async addError(jobId: string, itemUrl: string, kind: JobErrorKind, detail: string): Promise<void> {
    this.must(jobId).errors.push({ itemUrl, kind, detail });
  }

  async addResult(jobId: string, goodsId: string): Promise<void> {
    this.results.get(jobId)?.push(goodsId);
  }

  async listResults(jobId: string, cursor: string | undefined, limit: number) {
    const all = this.results.get(jobId) ?? [];
    const start = cursor ? parseInt(cursor, 10) || 0 : 0;
    const goodsIds = all.slice(start, start + limit);
    const next = start + goodsIds.length;
    return { goodsIds, ...(next < all.length ? { nextCursor: String(next) } : {}) };
  }

  async getJobIdForIdempotencyKey(key: string): Promise<string | null> {
    return this.idempotency.get(key) ?? null;
  }

  async setIdempotencyKey(key: string, jobId: string): Promise<void> {
    this.idempotency.set(key, jobId);
  }
}

export function createMemoryStores(): Stores {
  return { products: new MemoryProducts(), jobs: new MemoryJobs() };
}
