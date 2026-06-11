import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(8080),

  BRIGHTDATA_API_TOKEN: z.string().optional(),
  BRIGHTDATA_ZONE: z.string().default("shein_scrapper"),
  SCRAPE_DAILY_BUDGET: z.coerce.number().int().positive().default(500),

  API_KEYS: z.string().default(""),

  QUEUE_MODE: z.enum(["inline", "cloud_tasks"]).default("inline"),
  STORE_MODE: z.enum(["memory", "firestore"]).default("memory"),

  GCP_PROJECT: z.string().optional(),
  TASKS_LOCATION: z.string().default("europe-west2"),
  TASKS_QUEUE: z.string().default("shein-scrape"),
  WORKER_URL: z.string().optional(),
  // Service account Cloud Tasks mints OIDC tokens as (and that holds
  // run.invoker on the worker). Primary auth control in cloud_tasks mode.
  TASKS_INVOKER_SA: z.string().optional(),
  // Defence-in-depth shared secret; OIDC is the real gate.
  TASK_SECRET: z.string().optional(),

  PRODUCT_TTL_SECONDS: z.coerce.number().int().positive().default(6 * 3600),
  MAX_PRODUCTS_DEFAULT: z.coerce.number().int().positive().default(50),
  MAX_PRODUCTS_HARD: z.coerce.number().int().positive().default(500),
  MAX_REVIEW_PAGES_DEFAULT: z.coerce.number().int().positive().default(3),
});

export type Config = z.infer<typeof envSchema> & { apiKeys: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  const apiKeys = parsed.API_KEYS.split(",").map((k) => k.trim()).filter(Boolean);

  if (
    parsed.QUEUE_MODE === "cloud_tasks" &&
    (!parsed.GCP_PROJECT || !parsed.WORKER_URL || !parsed.TASKS_INVOKER_SA)
  ) {
    throw new Error(
      "QUEUE_MODE=cloud_tasks requires GCP_PROJECT, WORKER_URL and TASKS_INVOKER_SA",
    );
  }
  if (parsed.STORE_MODE === "firestore" && !parsed.GCP_PROJECT) {
    throw new Error("STORE_MODE=firestore requires GCP_PROJECT");
  }
  return { ...parsed, apiKeys };
}
