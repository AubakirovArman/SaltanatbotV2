import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("server trading startup ordering", () => {
  it("finishes persisted engine recovery before executor startup and HTTP listen", () => {
    const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const resume = source.indexOf(
      "await trading.engine.resume(createTradingResumeAuthorization(identityRuntime, runtimePolicy));"
    );
    const executor = source.indexOf("await trading.start();");
    const listen = source.indexOf("server.listen(port, host");

    expect(resume).toBeGreaterThan(-1);
    expect(executor).toBeGreaterThan(resume);
    expect(listen).toBeGreaterThan(executor);
    expect(source).not.toContain("void trading.engine.resume(");
  });

  it("drains the executor before engine shutdown and closing the SQLite store", () => {
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const routes = readFileSync(new URL("../src/trading/routes.ts", import.meta.url), "utf8");
    const quiesce = server.indexOf("trading.quiesce();");
    const resourceClose = server.indexOf("await trading.close();");
    const executorClose = routes.indexOf("await paperPortfolios.close()");
    const engineShutdown = routes.indexOf("engine.shutdown();", executorClose);
    const storeClose = routes.indexOf("closeStore();", engineShutdown);

    expect(quiesce).toBeGreaterThan(-1);
    expect(resourceClose).toBeGreaterThan(quiesce);
    expect(server).not.toContain("trading.engine.shutdown();");
    expect(executorClose).toBeGreaterThan(-1);
    expect(engineShutdown).toBeGreaterThan(executorClose);
    expect(storeClose).toBeGreaterThan(engineShutdown);
  });
});
