import { BudgetExceededError } from "../shared/errors.js";

/**
 * Daily unlocker-call ledger — the in-code spend fuse. Checked before every
 * fetch; outer fuses (Cloud Tasks dispatch rate, Bright Data zone cap, GCP
 * budget alerts) catch what this misses.
 */
export interface BudgetLedger {
  assertWithinBudget(): Promise<void>;
  record(ok: boolean, meta?: { url?: string; jobId?: string; renderUsed?: boolean }): Promise<void>;
}

export class InMemoryLedger implements BudgetLedger {
  private counts = new Map<string, number>();
  constructor(private readonly dailyBudget: number) {}

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  async assertWithinBudget(): Promise<void> {
    const used = this.counts.get(this.today()) ?? 0;
    if (used >= this.dailyBudget) throw new BudgetExceededError(used, this.dailyBudget);
  }

  async record(): Promise<void> {
    const day = this.today();
    this.counts.set(day, (this.counts.get(day) ?? 0) + 1);
  }
}
