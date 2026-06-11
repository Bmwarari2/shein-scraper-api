import { pino } from "pino";

/**
 * Structured JSON logs. On Cloud Run these flow to Cloud Logging; the
 * `event`/`outcome` fields feed the log-based metrics defined in infra/
 * (scrape_success_rate, scrape_block_rate, parse_error_rate).
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  messageKey: "message",
  formatters: {
    level: (label) => ({ severity: label.toUpperCase() }),
  },
});
