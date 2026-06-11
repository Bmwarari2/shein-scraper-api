import { CloudTasksClient } from "@google-cloud/tasks";
import { logger } from "../shared/logger.js";
import type { JobOptions } from "../schema/job.js";

/**
 * Task envelope and enqueuers. Inline mode runs handlers in-process (local
 * dev); cloud_tasks mode pushes HTTP tasks at the worker service, where Cloud
 * Tasks owns retry/backoff and the dispatch-rate spend throttle.
 */

export type TaskPayload =
  | { type: "scrape_product"; jobId: string; url: string; options: JobOptions }
  | {
      type: "scrape_grid_page";
      jobId: string;
      kind: "search" | "category";
      query?: string;
      url?: string;
      page: number;
      enqueuedSoFar: number;
      options: JobOptions;
    };

export interface Enqueuer {
  enqueue(payload: TaskPayload): Promise<void>;
}

/** Local dev: dispatch immediately in-process, fire-and-forget. */
export class InlineEnqueuer implements Enqueuer {
  private dispatch: ((payload: TaskPayload) => Promise<void>) | null = null;

  bind(dispatch: (payload: TaskPayload) => Promise<void>): void {
    this.dispatch = dispatch;
  }

  async enqueue(payload: TaskPayload): Promise<void> {
    if (!this.dispatch) throw new Error("InlineEnqueuer not bound to a dispatcher");
    const run = this.dispatch;
    setImmediate(() => {
      run(payload).catch((err) =>
        logger.error({ event: "inline_task_failed", type: payload.type, error: String(err) }),
      );
    });
  }
}

export class CloudTasksEnqueuer implements Enqueuer {
  private client = new CloudTasksClient();

  constructor(
    private readonly cfg: {
      project: string;
      location: string;
      queue: string;
      workerUrl: string;
      // SA Cloud Tasks signs the OIDC token as; must hold run.invoker on worker.
      invokerServiceAccount: string;
      taskSecret?: string;
    },
  ) {}

  async enqueue(payload: TaskPayload): Promise<void> {
    const parent = this.client.queuePath(this.cfg.project, this.cfg.location, this.cfg.queue);
    await this.client.createTask({
      parent,
      task: {
        httpRequest: {
          httpMethod: "POST",
          url: `${this.cfg.workerUrl}/internal/tasks`,
          headers: {
            "Content-Type": "application/json",
            // Defence-in-depth only; the OIDC token below is the real gate.
            ...(this.cfg.taskSecret ? { "X-Task-Secret": this.cfg.taskSecret } : {}),
          },
          // Cloud Tasks mints a Google-signed OIDC token per push. Cloud Run
          // validates it at the edge (caller needs run.invoker) and the worker
          // re-verifies signature + audience in-app (see server.ts). Audience is
          // the worker's base URL, per Cloud Run convention.
          oidcToken: {
            serviceAccountEmail: this.cfg.invokerServiceAccount,
            audience: this.cfg.workerUrl,
          },
          body: Buffer.from(JSON.stringify(payload)).toString("base64"),
        },
      },
    });
  }
}
