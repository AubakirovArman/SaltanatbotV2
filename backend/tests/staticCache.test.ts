import { describe, expect, it } from "vitest";
import { frontendCacheControl } from "../src/staticCache.js";

describe("frontend static cache policy", () => {
  it("revalidates update-sensitive shell resources", () => {
    expect(frontendCacheControl("index.html")).toBe("no-cache");
    expect(frontendCacheControl("manifest.webmanifest")).toBe("no-cache");
    expect(frontendCacheControl("service-worker.js")).toBe("no-cache");
  });

  it("makes content-hashed build assets immutable but not public stable names", () => {
    expect(frontendCacheControl("assets/index-DwqJQzSi.js")).toBe("public, max-age=31536000, immutable");
    expect(frontendCacheControl("assets/index-BnLaxb3O.css")).toBe("public, max-age=31536000, immutable");
    expect(frontendCacheControl("logo.png")).toBe("public, max-age=0");
    expect(frontendCacheControl("blockly-media/sprites.svg")).toBe("public, max-age=0");
  });
});
