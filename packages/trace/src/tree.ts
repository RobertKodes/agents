import type { SpanRecord } from "./types.js";

export interface SpanNode extends SpanRecord {
  children: SpanNode[];
}

/**
 * Builds the trace tree the explorer renders. Spans whose parent is missing
 * (e.g. still being written) are surfaced as roots rather than dropped.
 */
export function buildTree(records: readonly SpanRecord[]): SpanNode[] {
  const nodes = new Map<string, SpanNode>();
  for (const r of records) nodes.set(r.id, { ...r, children: [] });

  const roots: SpanNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const byStart = (a: SpanNode, b: SpanNode) => a.startedAt - b.startedAt;
  const sortDeep = (list: SpanNode[]) => {
    list.sort(byStart);
    for (const n of list) sortDeep(n.children);
  };
  sortDeep(roots);
  return roots;
}
