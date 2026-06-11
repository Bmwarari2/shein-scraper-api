import { WrongCurrencyError } from "../shared/errors.js";
import { isObj, type Node } from "./extract-json.js";

/**
 * GBP enforcement lives here: every price we read carries either an
 * `amountWithSymbol` ("£11.08") or a currency code somewhere on the node.
 * Anything that isn't provably GBP throws WrongCurrencyError, which the
 * worker records as a non-retryable wrong_currency item failure — a geo
 * misconfiguration must alert, never store mislabeled numbers.
 */

/** "11.08" → 1108. Returns 0 for absent/unparseable amounts. */
export function pence(amount: unknown): number {
  if (amount == null) return 0;
  const n = parseFloat(String(amount));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Read `{ amount, amountWithSymbol?, currency? }`, asserting GBP when evidence exists. */
export function gbpPenceFromPriceNode(node: unknown): number {
  if (!isObj(node)) return 0;
  const symbol = node.amountWithSymbol;
  if (typeof symbol === "string" && symbol.trim() && !symbol.trim().startsWith("£")) {
    throw new WrongCurrencyError(symbol);
  }
  const code = (node.currency ?? node.currencyCode) as unknown;
  if (typeof code === "string" && code && code.toUpperCase() !== "GBP") {
    throw new WrongCurrencyError(code);
  }
  return pence(node.amount);
}

export function discountPercent(salePence: number, retailPence: number): number | undefined {
  if (retailPence <= salePence || retailPence <= 0) return undefined;
  return Math.round((100 * (retailPence - salePence)) / retailPence);
}

export type PriceNodePair = { sale: number; retail: number };

/** Extract sale/retail pence from a SKU's priceInfo node. */
export function priceFromSku(sku: Node): PriceNodePair {
  const pi = isObj(sku.priceInfo) ? (sku.priceInfo as Node) : null;
  return {
    sale: gbpPenceFromPriceNode(pi?.salePrice),
    retail: gbpPenceFromPriceNode(pi?.retailPrice),
  };
}
