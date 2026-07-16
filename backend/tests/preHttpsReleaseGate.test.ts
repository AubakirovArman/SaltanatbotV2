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
});
