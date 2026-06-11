import { FieldValue, Firestore } from "@google-cloud/firestore";
import { jobSchema, type Job, type JobErrorKind, type JobStatus } from "../schema/job.js";
import { productSchema, type Product } from "../schema/product.js";
import { BudgetExceededError } from "../shared/errors.js";
import type { BudgetLedger } from "../fetch/budget.js";
import type { ItemStatus, JobsRepo, ProductsRepo, Stores } from "./repos.js";

/**
 * Firestore-backed stores. Layout:
 *   products/{goodsId}                 — latest Product snapshot
 *   jobs/{jobId}                       — Job document (counts via increments)
 *   jobs/{jobId}/items/{itemKey}       — settled-item markers (idempotency)
 *   jobs/{jobId}/results/{seq}         — goodsId refs in completion order
 *   idempotency/{key}                  — Idempotency-Key → jobId
 *   scrape_calls/{YYYY-MM-DD}          — daily unlocker-call ledger
 */

const COUNT_FIELD: Record<ItemStatus, string> = {
  succeeded: "counts.succeeded",
  cached: "counts.cached",
  blocked: "counts.blocked",
  parse_error: "counts.parseErrors",
};

class FirestoreProducts implements ProductsRepo {
  constructor(private readonly db: Firestore) {}

  async get(goodsId: string): Promise<Product | null> {
    const snap = await this.db.collection("products").doc(goodsId).get();
    if (!snap.exists) return null;
    const parsed = productSchema.safeParse(snap.data());
    return parsed.success ? parsed.data : null; // old schemaVersion docs read as miss
  }

  async getFresh(goodsId: string, maxAgeSeconds: number): Promise<Product | null> {
    const p = await this.get(goodsId);
    if (!p) return null;
    const age = (Date.now() - Date.parse(p.scrapedAt)) / 1000;
    return age <= maxAgeSeconds ? p : null;
  }

  async upsert(product: Product): Promise<void> {
    await this.db.collection("products").doc(product.goodsId).set(product);
  }
}

class FirestoreJobs implements JobsRepo {
  constructor(private readonly db: Firestore) {}

  private doc(jobId: string) {
    return this.db.collection("jobs").doc(jobId);
  }

  async create(job: Job): Promise<void> {
    await this.doc(job.jobId).create(job);
  }

  async get(jobId: string): Promise<Job | null> {
    const snap = await this.doc(jobId).get();
    if (!snap.exists) return null;
    const parsed = jobSchema.safeParse(snap.data());
    if (!parsed.success) throw new Error(`corrupt job doc ${jobId}: ${parsed.error.message}`);
    return parsed.data;
  }

  async setStatus(jobId: string, status: JobStatus, finished = false): Promise<void> {
    await this.doc(jobId).update({
      status,
      ...(status === "running" ? { startedAt: new Date().toISOString() } : {}),
      ...(finished ? { finishedAt: new Date().toISOString() } : {}),
    });
  }

  async trySettleItem(jobId: string, itemKey: string, status: ItemStatus): Promise<boolean> {
    const itemRef = this.doc(jobId).collection("items").doc(itemKey);
    try {
      await this.db.runTransaction(async (tx) => {
        const existing = await tx.get(itemRef);
        if (existing.exists) throw new AlreadySettled();
        tx.create(itemRef, { status, settledAt: new Date().toISOString() });
        tx.update(this.doc(jobId), { [COUNT_FIELD[status]]: FieldValue.increment(1) });
      });
      return true;
    } catch (err) {
      if (err instanceof AlreadySettled) return false;
      throw err;
    }
  }

  async addDiscovered(jobId: string, count: number): Promise<void> {
    await this.doc(jobId).update({ "counts.discovered": FieldValue.increment(count) });
  }

  async markFanoutComplete(jobId: string): Promise<void> {
    await this.doc(jobId).update({ fanoutComplete: true });
  }

  async addError(jobId: string, itemUrl: string, kind: JobErrorKind, detail: string): Promise<void> {
    await this.doc(jobId).update({
      errors: FieldValue.arrayUnion({ itemUrl, kind, detail: detail.slice(0, 500) }),
    });
  }

  async addResult(jobId: string, goodsId: string): Promise<void> {
    await this.doc(jobId).collection("results").add({
      goodsId,
      at: new Date().toISOString(),
    });
  }

  async listResults(jobId: string, cursor: string | undefined, limit: number) {
    let q = this.doc(jobId).collection("results").orderBy("at").limit(limit);
    if (cursor) {
      const cursorSnap = await this.doc(jobId).collection("results").doc(cursor).get();
      if (cursorSnap.exists) q = q.startAfter(cursorSnap);
    }
    const snaps = await q.get();
    const goodsIds = snaps.docs.map((d) => String(d.get("goodsId")));
    const last = snaps.docs[snaps.docs.length - 1];
    return {
      goodsIds,
      ...(snaps.size === limit && last ? { nextCursor: last.id } : {}),
    };
  }

  async getJobIdForIdempotencyKey(key: string): Promise<string | null> {
    const snap = await this.db.collection("idempotency").doc(key).get();
    return snap.exists ? String(snap.get("jobId")) : null;
  }

  async setIdempotencyKey(key: string, jobId: string): Promise<void> {
    await this.db.collection("idempotency").doc(key).set({ jobId });
  }
}

class AlreadySettled extends Error {}

/** Firestore-backed daily unlocker ledger (the durable spend fuse). */
export class FirestoreLedger implements BudgetLedger {
  constructor(private readonly db: Firestore, private readonly dailyBudget: number) {}

  private ref() {
    return this.db.collection("scrape_calls").doc(new Date().toISOString().slice(0, 10));
  }

  async assertWithinBudget(): Promise<void> {
    const snap = await this.ref().get();
    const used = snap.exists ? Number(snap.get("count") ?? 0) : 0;
    if (used >= this.dailyBudget) throw new BudgetExceededError(used, this.dailyBudget);
  }

  async record(ok: boolean, meta: { url?: string; jobId?: string; renderUsed?: boolean } = {}) {
    await this.ref().set(
      {
        count: FieldValue.increment(1),
        ...(ok ? {} : { failures: FieldValue.increment(1) }),
        ...(meta.renderUsed ? { renders: FieldValue.increment(1) } : {}),
      },
      { merge: true },
    );
  }
}

export function createFirestoreStores(projectId: string): Stores & { db: Firestore } {
  const db = new Firestore({ projectId });
  return { db, products: new FirestoreProducts(db), jobs: new FirestoreJobs(db) };
}
