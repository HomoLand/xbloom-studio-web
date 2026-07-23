/**
 * Static GitHub Pages / CDN deploy flags.
 * When VITE_STATIC=1 the SPA runs without a local FastAPI host.
 */

export function isStaticDeploy(): boolean {
  return import.meta.env.VITE_STATIC === "1";
}

/** Vite base path, e.g. `/xbloom-studio-web/` on GitHub Pages. */
export function appBaseUrl(): string {
  const base = import.meta.env.BASE_URL || "/";
  return base.endsWith("/") ? base : `${base}/`;
}
