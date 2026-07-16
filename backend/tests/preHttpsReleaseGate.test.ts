import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("pre-HTTPS deployment release gate", () => {
  it("hard-pins Compose to Research / Paper without live activator passthroughs", () => {
    const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");

    expect(compose).toMatch(/^\s+RUNTIME_PROFILE: public-http-paper$/m);
    expect(compose).not.toContain("${RUNTIME_PROFILE");
    expect(compose).not.toMatch(/^\s+(?:ENABLE_LIVE_SPOT|ALLOW_INSECURE_TRADING_MUTATIONS):/m);
  });

  it("publishes only the runnable profile in the example environment", () => {
    const example = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");

    expect(example).toMatch(/^RUNTIME_PROFILE=public-http-paper$/m);
    expect(example).not.toMatch(/^[^#\n]*RUNTIME_PROFILE=private-live$/m);
  });

  it("passes every documented workspace quota through the web Compose service", () => {
    const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
    const defaults = {
      WORKSPACE_MAX_ACTIVE_PER_USER: "25",
      WORKSPACE_MAX_TOTAL_PER_USER: "75",
      WORKSPACE_MAX_REVISIONS_PER_WORKSPACE: "20",
      WORKSPACE_MAX_DOCUMENT_BYTES: "1048576",
      WORKSPACE_MAX_RETAINED_PAYLOAD_BYTES_PER_USER: "67108864"
    };

    for (const [name, fallback] of Object.entries(defaults)) {
      expect(compose).toContain(`${name}: \${${name}:-${fallback}}`);
    }
  });
});
