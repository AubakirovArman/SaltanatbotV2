import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const apiUnit = readFileSync(new URL("../../deploy/systemd/saltanatbotv2.service.example", import.meta.url), "utf8");
const workerUnit = readFileSync(new URL("../../deploy/systemd/saltanatbotv2-research-worker.service.example", import.meta.url), "utf8");

describe("direct-host systemd examples", () => {
  it.each([
    ["API", apiUnit],
    ["research worker", workerUnit]
  ])("keeps the %s unprivileged, bounded and paper-only", (_name, unit) => {
    expect(unit).toContain("User=saltanatbotv2");
    expect(unit).toContain("Group=saltanatbotv2");
    expect(unit).toContain("Environment=RUNTIME_PROFILE=public-http-paper");
    expect(unit).toContain("Environment=PGPASSWORD_FILE=/etc/saltanatbotv2/postgres_password");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("CapabilityBoundingSet=");
    expect(unit).toContain("MemoryMax=");
    expect(unit).not.toContain("private-live");
    expect(unit).not.toContain("ENABLE_LIVE_SPOT");
    expect(unit).not.toContain("ALLOW_INSECURE_TRADING_MUTATIONS");
  });

  it("gives only the API write access to the trading data directory", () => {
    expect(apiUnit).toContain("ReadWritePaths=/opt/saltanatbotv2/backend/data");
    expect(apiUnit).toContain("ExecStart=/usr/bin/node /opt/saltanatbotv2/backend/dist/server.js");
    expect(workerUnit).not.toContain("ReadWritePaths=");
    expect(workerUnit).not.toContain("backend/data");
    expect(workerUnit).toContain("ExecStart=/usr/bin/node /opt/saltanatbotv2/backend/dist/workers/researchWorker.js");
  });
});
