import { z } from "zod";

export const jobTypeSchema = z.enum(["product", "search", "category"]);
export type JobType = z.infer<typeof jobTypeSchema>;

export const freshnessSchema = z
  .union([z.literal("cache_ok"), z.literal("force"), z.string().regex(/^max_age:\d+$/)])
  .default("cache_ok");

export const jobOptionsSchema = z.object({
  maxProducts: z.number().int().positive().optional(),
  includeReviews: z.boolean().default(false),
  maxReviewPages: z.number().int().positive().optional(),
  freshness: freshnessSchema,
  webhookUrl: z.string().url().optional(),
});
export type JobOptions = z.infer<typeof jobOptionsSchema>;

export const jobErrorKindSchema = z.enum([
  "blocked",
  "parse_error",
  "wrong_currency",
  "budget_exceeded",
  "invalid_url",
  "internal",
]);
export type JobErrorKind = z.infer<typeof jobErrorKindSchema>;

export const jobStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "completed_with_errors",
  "failed",
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobSchema = z.object({
  jobId: z.string(),
  type: jobTypeSchema,
  input: z.object({ url: z.string().optional(), query: z.string().optional() }),
  options: jobOptionsSchema,
  status: jobStatusSchema,
  /** Fan-out complete: no more items will be discovered for this job. */
  fanoutComplete: z.boolean(),
  counts: z.object({
    discovered: z.number().int(),
    succeeded: z.number().int(),
    cached: z.number().int(),
    blocked: z.number().int(),
    parseErrors: z.number().int(),
  }),
  errors: z.array(
    z.object({ itemUrl: z.string(), kind: jobErrorKindSchema, detail: z.string() }),
  ),
  apiKeyId: z.string(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});
export type Job = z.infer<typeof jobSchema>;

export function newJob(args: {
  jobId: string;
  type: JobType;
  input: Job["input"];
  options: JobOptions;
  apiKeyId: string;
  discovered: number;
  fanoutComplete: boolean;
}): Job {
  return {
    jobId: args.jobId,
    type: args.type,
    input: args.input,
    options: args.options,
    status: "queued",
    fanoutComplete: args.fanoutComplete,
    counts: { discovered: args.discovered, succeeded: 0, cached: 0, blocked: 0, parseErrors: 0 },
    errors: [],
    apiKeyId: args.apiKeyId,
    createdAt: new Date().toISOString(),
  };
}

/** Terminal item count — when this reaches `discovered` and fan-out is done, the job is over. */
export function settledCount(job: Job): number {
  const c = job.counts;
  return c.succeeded + c.cached + c.blocked + c.parseErrors;
}

export function finalStatus(job: Job): JobStatus {
  const failures = job.counts.blocked + job.counts.parseErrors;
  if (failures === 0) return "completed";
  if (job.counts.succeeded + job.counts.cached === 0) return "failed";
  return "completed_with_errors";
}
