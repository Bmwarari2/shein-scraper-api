import { BrightDataClient, type Fetcher } from "./fetch/brightdata.js";
import { InMemoryLedger, type BudgetLedger } from "./fetch/budget.js";
import type { Config } from "./shared/config.js";
import { createFirestoreStores, FirestoreLedger } from "./store/firestore.js";
import { createMemoryStores } from "./store/memory.js";
import type { Stores } from "./store/repos.js";
import { dispatchTask, type WorkerDeps } from "./worker/handlers.js";
import { CloudTasksEnqueuer, InlineEnqueuer, type Enqueuer } from "./worker/tasks.js";

/** Composition root: wires stores, ledger, fetcher and enqueuer from config. */

export interface AppDeps extends WorkerDeps {
  ledger: BudgetLedger;
}

export function buildDeps(config: Config, overrides: { fetcher?: Fetcher } = {}): AppDeps {
  let stores: Stores;
  let ledger: BudgetLedger;
  if (config.STORE_MODE === "firestore") {
    const fs = createFirestoreStores(config.GCP_PROJECT!);
    stores = fs;
    ledger = new FirestoreLedger(fs.db, config.SCRAPE_DAILY_BUDGET);
  } else {
    stores = createMemoryStores();
    ledger = new InMemoryLedger(config.SCRAPE_DAILY_BUDGET);
  }

  let fetcher = overrides.fetcher;
  if (!fetcher) {
    if (!config.BRIGHTDATA_API_TOKEN) {
      throw new Error("BRIGHTDATA_API_TOKEN is required (or inject a Fetcher override)");
    }
    fetcher = new BrightDataClient(
      { apiToken: config.BRIGHTDATA_API_TOKEN, zone: config.BRIGHTDATA_ZONE },
      ledger,
    );
  }

  let enqueuer: Enqueuer;
  const deps: AppDeps = {
    stores,
    fetcher,
    ledger,
    enqueuer: undefined as unknown as Enqueuer, // assigned below
    config: {
      PRODUCT_TTL_SECONDS: config.PRODUCT_TTL_SECONDS,
      MAX_PRODUCTS_DEFAULT: config.MAX_PRODUCTS_DEFAULT,
      MAX_PRODUCTS_HARD: config.MAX_PRODUCTS_HARD,
    },
  };

  if (config.QUEUE_MODE === "cloud_tasks") {
    enqueuer = new CloudTasksEnqueuer({
      project: config.GCP_PROJECT!,
      location: config.TASKS_LOCATION,
      queue: config.TASKS_QUEUE,
      workerUrl: config.WORKER_URL!,
      invokerServiceAccount: config.TASKS_INVOKER_SA!,
      ...(config.TASK_SECRET ? { taskSecret: config.TASK_SECRET } : {}),
    });
  } else {
    const inline = new InlineEnqueuer();
    inline.bind((payload) => dispatchTask(deps, payload));
    enqueuer = inline;
  }
  deps.enqueuer = enqueuer;
  return deps;
}
