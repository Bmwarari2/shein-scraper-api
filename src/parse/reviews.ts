import { reviewSchema, type Review } from "../schema/product.js";
import { isObj, type Node } from "./extract-json.js";

/**
 * Reviews parser — PHASE 0 STUB.
 *
 * Shein serves reviews from a paginated JSON endpoint keyed by goods_id /
 * goods_sn (observable in devtools on any product page's review section).
 * Phase 0 captures real responses as fixtures; the field mapping below is the
 * expected shape and must be confirmed against those fixtures before the
 * reviews task handler is enabled.
 */

export interface ReviewsPage {
  reviews: Review[];
  /** Aggregate block when the endpoint returns one (average + total count). */
  aggregate?: { average: number; count: number };
  hasMore: boolean;
}

export function parseReviewsJson(payload: unknown): ReviewsPage {
  if (!isObj(payload)) return { reviews: [], hasMore: false };
  const info = isObj(payload.info) ? (payload.info as Node) : payload;
  const rawList = Array.isArray(info.comment_info) ? (info.comment_info as Node[]) : [];

  const reviews: Review[] = [];
  for (const r of rawList) {
    if (!isObj(r)) continue;
    const candidate = {
      reviewId: String(r.comment_id ?? ""),
      rating: Number(r.comment_rank ?? 0),
      date: String(r.add_time ?? ""),
      text: String(r.content ?? ""),
      ...(r.language_flag ? { language: String(r.language_flag) } : {}),
      ...(r.color ? { colorPurchased: String(r.color) } : {}),
      ...(r.size ? { sizePurchased: String(r.size) } : {}),
      imageUrls: Array.isArray(r.comment_image)
        ? (r.comment_image as Node[])
            .map((i) => (isObj(i) ? String(i.member_image_original ?? "") : ""))
            .filter(Boolean)
        : [],
    };
    const checked = reviewSchema.safeParse(candidate);
    if (checked.success) reviews.push(checked.data);
  }

  return { reviews, hasMore: reviews.length > 0 };
}
