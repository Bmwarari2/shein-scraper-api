/**
 * Utilities for pulling JSON out of Shein's server-rendered pages.
 *
 * Product/search state ships as a `gbRawData = {...}` script assignment. We
 * brace/bracket-match rather than regex because the blob nests thousands of
 * levels of braces and contains braces inside strings — a non-greedy regex
 * truncates at the first nested closer.
 *
 * Navigation into the parsed blob uses bounded structural searches (deepFind)
 * instead of hardcoded paths: Shein reshuffles the tree often, but the
 * identifying shape of each node (e.g. "has goods_name + goods_id + goods_sn")
 * is far more stable than its location.
 */

export type Node = Record<string, unknown>;

export const isObj = (x: unknown): x is Node =>
  !!x && typeof x === "object" && !Array.isArray(x);

/** Brace/bracket-match and JSON.parse a `marker = {...}` / `"marker": [...]` assignment. */
export function extractJsonAssignment(html: string, marker: RegExp): unknown {
  const m = html.match(marker);
  if (!m || m.index == null) return null;
  const afterMarker = m.index + m[0].length;

  let start = -1;
  for (let i = afterMarker - 1; i < html.length; i++) {
    const c = html[i]!;
    if (c === "{" || c === "[") { start = i; break; }
    if (!/[\s=:]/.test(c)) return null;
  }
  if (start === -1) return null;

  const open = html[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

export function extractGbRawData(html: string): Node | null {
  const parsed = extractJsonAssignment(html, /gbRawData\s*=\s*\{/);
  return isObj(parsed) ? parsed : null;
}

/** Depth-first search for the first object node matching the predicate. */
export function deepFind(root: unknown, pred: (n: Node) => boolean, maxDepth = 12): Node | null {
  const stack: Array<[unknown, number]> = [[root, 0]];
  while (stack.length) {
    const [node, d] = stack.pop()!;
    if (!node || typeof node !== "object" || d > maxDepth) continue;
    if (isObj(node) && pred(node)) return node;
    for (const v of Object.values(node as Node)) stack.push([v, d + 1]);
  }
  return null;
}

/** Depth-first search for the first non-empty array matching the predicate. */
export function deepFindArray(
  root: unknown,
  pred: (arr: unknown[]) => boolean,
  maxDepth = 12,
): unknown[] | null {
  const stack: Array<[unknown, number]> = [[root, 0]];
  while (stack.length) {
    const [node, d] = stack.pop()!;
    if (!node || typeof node !== "object" || d > maxDepth) continue;
    if (Array.isArray(node) && node.length && pred(node)) return node;
    for (const v of Object.values(node as Node)) stack.push([v, d + 1]);
  }
  return null;
}

/** Collect every object node matching the predicate (e.g. all SKC/colour nodes). */
export function deepCollect(root: unknown, pred: (n: Node) => boolean, maxDepth = 12): Node[] {
  const out: Node[] = [];
  const stack: Array<[unknown, number]> = [[root, 0]];
  while (stack.length) {
    const [node, d] = stack.pop()!;
    if (!node || typeof node !== "object" || d > maxDepth) continue;
    if (isObj(node) && pred(node)) out.push(node);
    for (const v of Object.values(node as Node)) stack.push([v, d + 1]);
  }
  return out;
}
