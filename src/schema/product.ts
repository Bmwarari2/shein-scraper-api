import { z } from "zod";

/**
 * Single source of truth for stored/served product documents.
 * Money is integer pence with a GBP literal — the parser fails closed on any
 * other currency, so a non-GBP value can never reach this schema.
 */

export const SCHEMA_VERSION = 1;

export const priceSchema = z.object({
  currency: z.literal("GBP"),
  amountPence: z.number().int().nonnegative(),
  retailAmountPence: z.number().int().nonnegative().optional(),
  discountPercent: z.number().int().min(0).max(100).optional(),
});
export type Price = z.infer<typeof priceSchema>;

export const stockStatusSchema = z.enum(["in_stock", "low_stock", "out_of_stock", "unknown"]);
export type StockStatus = z.infer<typeof stockStatusSchema>;

export const variantSchema = z.object({
  skuCode: z.string().optional(),
  color: z.string(),
  colorImageUrl: z.string().optional(),
  size: z.string(),
  price: priceSchema.optional(),
  stock: z.object({
    status: stockStatusSchema,
    quantity: z.number().int().nonnegative().optional(),
  }),
});
export type Variant = z.infer<typeof variantSchema>;

export const reviewSchema = z.object({
  reviewId: z.string(),
  rating: z.number().min(1).max(5),
  date: z.string(),
  text: z.string(),
  language: z.string().optional(),
  translated: z.boolean().optional(),
  colorPurchased: z.string().optional(),
  sizePurchased: z.string().optional(),
  fitFeedback: z.enum(["true_to_size", "runs_small", "runs_large", "unknown"]).optional(),
  imageUrls: z.array(z.string()),
});
export type Review = z.infer<typeof reviewSchema>;

export const productSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  goodsId: z.string().min(1),
  goodsSn: z.string().optional(),
  sourceUrl: z.string().url(),
  region: z.literal("GB"),
  title: z.string().min(1),
  description: z.string(),
  categoryPath: z.array(z.string()).optional(),
  brand: z.string().optional(),
  price: priceSchema,
  images: z.array(z.string()),
  variants: z.array(variantSchema),
  rating: z.object({ average: z.number(), count: z.number().int() }).optional(),
  reviews: z.array(reviewSchema).optional(),
  reviewsTruncated: z.boolean().optional(),
  quality: z.enum(["full", "partial"]),
  scrapedAt: z.string(),
  parserVersion: z.string(),
});
export type Product = z.infer<typeof productSchema>;
