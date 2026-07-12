const IMMUTABLE_BUILD_ASSET = /^assets\/.+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

/** HTTP cache policy aligned with the generated offline shell. */
export function frontendCacheControl(relativePath: string) {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (["index.html", "manifest.webmanifest", "service-worker.js"].includes(normalized)) return "no-cache";
  if (IMMUTABLE_BUILD_ASSET.test(normalized)) return "public, max-age=31536000, immutable";
  return "public, max-age=0";
}
