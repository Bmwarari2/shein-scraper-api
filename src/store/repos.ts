import type { Job, JobErrorKind, JobStatus } from "../schema/job.js";
import type { Product } from "../schema/product.js";

/**
 * Storage interfaces. Two implementations: memory (local dev, tests) and
 * Firestore (production). Everything the API/worker needs goes through these,
 * so swapping Firestore for Cloud SQL later is contained to one module.
 */

export type ItemStatus = "succeeded" | "cached" | "blocked" | "parse_error";

export interface ProductsRepo {
  get(goodsId: string): Promise<Product | null>;
  /** Returns the product only if scraped within maxAgeSeconds. */
  getFresh(goodsId: string, maxAgeSeconds: number): Promise<Product | null>;
  upsert(product: Product): Promise<void>;
}

export interface JobsRepo {
  create(job: Job): Promise<void>;
  get(jobId: string): Promise<Job | null>;
  setStatus(jobId: string, status: JobStatus, finished?: boolean): Promise<void>;
  /** Idempotency guard: returns false if this item was already settled. */
  trySettleItem(jobId: string, itemKey: string, status: ItemStatus): Promise<boolean>;
  addDiscovered(jobId: string, count: number): Promise<void>;
  markFanoutComplete(jobId: string): Promise<void>;
  addError(jobId: string, itemUrl: string, kind: JobErrorKind, detail: string): Promise<void>;
  addResult(jobId: string, goodsId: string): Promise<void>;
  listResults(jobId: string, cursor: string | undefined, limit: number): Promise<{
    goodsIds: string[];
    nextCursor?: string;
  }>;
  /** Idempotency-Key support on job creation. */
  getJobIdForIdempotencyKey(key: string): Promise<string | null>;
  setIdempotencyKey(key: string, jobId: string): Promise<void>;
}

export interface Stores {
  products: ProductsRepo;
  jobs: JobsRepo;
}
