export interface Pos {
  x: number;
  y: number;
}

/**
 * Puts a graph in columns by dependency depth (the longest chain of arrows that leads to a node), top to bottom within
 * a column in the order the nodes were given. Enough for a plan with a few dozen tasks; nothing is guessed about crossings.
 */
export function layerLayout(
  ids: string[],
  edges: Array<{ source: string; target: string }>,
  size = { w: 230, h: 92, gx: 80, gy: 28 },
): Record<string, Pos> {
  const known = new Set(ids);
  const into = new Map<string, string[]>();
  for (const e of edges)
    if (known.has(e.source) && known.has(e.target))
      into.set(e.target, [...(into.get(e.target) ?? []), e.source]);
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const seen = depth.get(id);
    if (seen !== undefined) return seen;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const d = Math.max(-1, ...(into.get(id) ?? []).map(depthOf)) + 1;
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  const rows = new Map<number, number>();
  const out: Record<string, Pos> = {};
  for (const id of ids) {
    const d = depthOf(id);
    const row = rows.get(d) ?? 0;
    rows.set(d, row + 1);
    out[id] = { x: d * (size.w + size.gx), y: row * (size.h + size.gy) };
  }
  return out;
}
