import { BlockedError, RetryableError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import type { BudgetLedger } from "./budget.js";

/**
 * Bright Data Web Unlocker client, direct-API mode
 * (POST https://api.brightdata.com/request with a zone-scoped token).
 *
 * Cost policy (the §5.4 guardrails):
 *  - budget ledger checked before every call;
 *  - never used for images/assets (those download directly from Shein's CDN).
 *
 * JS rendering: Web Unlocker renders automatically when a page needs it — there
 * is NO `render` request field (verified against Bright Data docs, Phase 0).
 * `opts.render` therefore no longer changes the request; it survives only as a
 * "this is the missing-blob retry" marker for ledger/telemetry. The retry is a
 * plain re-fetch (a fresh unlocker attempt may route past a transient block).
 *
 * PHASE 0 remaining: confirm premium-domain pricing for shein.co.uk and that a
 * plain fetch reliably carries gbRawData. The zone is configured geo=gb + cap.
 */

export interface Fetcher {
  fetchHtml(url: string, opts?: { render?: boolean; jobId?: string }): Promise<string>;
}

const ENDPOINT = "https://api.brightdata.com/request";
const MAX_ATTEMPTS = 2; // Cloud Tasks owns real retries; this only smooths transient 429/5xx.

export class BrightDataClient implements Fetcher {
  constructor(
    private readonly cfg: { apiToken: string; zone: string; timeoutMs?: number },
    private readonly ledger: BudgetLedger,
  ) {}

  async fetchHtml(url: string, opts: { render?: boolean; jobId?: string } = {}): Promise<string> {
    await this.ledger.assertWithinBudget();

    const body: Record<string, unknown> = {
      zone: this.cfg.zone,
      url,
      format: "raw",
      country: "gb",
    };

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const startedAt = Date.now();
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.cfg.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 120_000),
        });

        if (res.status === 429 || res.status >= 500) {
          const text = await res.text().catch(() => "");
          throw new RetryableError(`unlocker HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        if (!res.ok) {
          // 4xx other than 429: bad request/auth/zone — not retryable here.
          const text = await res.text().catch(() => "");
          await this.ledger.record(false, { url, ...opts });
          throw new Error(`unlocker HTTP ${res.status}: ${text.slice(0, 200)}`);
        }

        const html = await res.text();
        await this.ledger.record(true, {
          url,
          ...(opts.jobId ? { jobId: opts.jobId } : {}),
          renderUsed: !!opts.render,
        });
        logger.info({
          event: "unlocker_fetch",
          outcome: "ok",
          url,
          bytes: html.length,
          renderUsed: !!opts.render,
          latencyMs: Date.now() - startedAt,
          jobId: opts.jobId,
        });
        return html;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (!(lastError instanceof RetryableError) && lastError.name !== "TimeoutError") break;
        if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 2_000 * attempt));
      }
    }

    await this.ledger
      .record(false, { url, ...(opts.jobId ? { jobId: opts.jobId } : {}) })
      .catch(() => {});
    logger.warn({ event: "unlocker_fetch", outcome: "error", url, error: lastError?.message });
    throw lastError instanceof RetryableError
      ? new BlockedError(lastError.message)
      : (lastError ?? new Error("unlocker request failed"));
  }
}
