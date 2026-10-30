/*
 * "Is there a newer build?" — the page's module script is /assets/index-<hash>.js and the hash
 * changes with every build, so a different one in the HTML the server serves now means this
 * tab is running an older bundle. See src/components/UpdateBar.tsx.
 *
 * Node-loadable: no browser APIs.
 */

/** The `src` of the module script in an HTML page, or null. */
export function moduleScript(html: string): string | null {
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (!/\btype\s*=\s*["']?module\b/i.test(tag)) continue;
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (src) return src[1];
  }
  return null;
}
