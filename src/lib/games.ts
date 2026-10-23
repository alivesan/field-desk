/**
 * A campaign's game list from what HQ typed: comma- or line-separated, trimmed, inner spaces
 * collapsed, duplicates dropped (case-insensitive, first spelling wins).
 */
export function parseGames(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const g = raw.trim().replace(/\s+/g, ' ');
    const key = g.toLowerCase();
    if (!g || seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

export const sameGames = (a: string[], b: string[]) => a.length === b.length && a.every((g, i) => g === b[i]);
