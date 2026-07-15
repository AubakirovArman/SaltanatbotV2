import { describe, expect, it } from "vitest";
import { launchView } from "../src/app/launchView";

describe("installed app launch view", () => {
  it("opens each explicitly supported workspace", () => {
    expect(launchView("?view=strategy")).toBe("strategy");
    expect(launchView("?view=trade")).toBe("trade");
    expect(launchView("?view=screener")).toBe("screener");
    expect(launchView("?view=chart")).toBe("chart");
  });

  it("fails closed to the chart for unknown launch values", () => {
    expect(launchView("?view=%0Astrategy")).toBe("chart");
    expect(launchView("?other=strategy")).toBe("chart");
  });
});
