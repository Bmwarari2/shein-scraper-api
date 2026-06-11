import { z } from "zod";
import { jobOptionsSchema, jobTypeSchema } from "./job.js";

/** POST /v1/jobs request body. */
export const createJobBodySchema = z
  .object({
    type: jobTypeSchema,
    url: z.string().url().optional(),
    query: z.string().min(2).max(200).optional(),
    options: jobOptionsSchema.partial().default({}),
  })
  .superRefine((body, ctx) => {
    if (body.type === "search" && !body.query) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "search jobs require `query`" });
    }
    if ((body.type === "product" || body.type === "category") && !body.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${body.type} jobs require \`url\`` });
    }
  });
export type CreateJobBody = z.infer<typeof createJobBodySchema>;

export const resultsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
