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
            // v0 shared-secret auth; replace with OIDC token + audience check
            // (Cloud Tasks oidcToken field) before exposing the worker at all.
            ...(this.cfg.taskSecret ? { "X-Task-Secret": this.cfg.taskSecret } : {}),
          },
          body: Buffer.from(JSON.stringify(payload)).toString("base64"),
        },
      },
    });
  }
}
