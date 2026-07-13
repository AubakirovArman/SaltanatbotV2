import { describe, expect, it } from "vitest";
import { launchView } from "../src/app/launchView";

describe("installed app launch view", () => {
  it("opens only the explicitly supported research shortcut", () => {
    expect(launchView("?view=strategy")).toBe("strategy");
    expect(launchView("?view=chart")).toBe("chart");
  });

  it("fails closed to the chart for unknown or trading launch values", () => {
    expect(launchView("?view=trade")).toBe("chart");
    expect(launchView("?view=%0Astrategy")).toBe("chart");
    expect(launchView("?other=strategy")).toBe("chart");
  });
});
