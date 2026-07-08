import { describe, expect, it } from "vitest";
import {
  commandToExec,
  formatExec,
  parseCommands,
  parseMessageSet,
  parseTpLevels,
} from "../src/trading/commands.js";

describe("parseMessageSet", () => {
  it("splits `::`-chained commands into ordered steps", () => {
    const steps = parseMessageSet("action=openposition;symbol=BTCUSDT;qty=1 :: action=closeposition;symbol=BTCUSDT");
    expect(steps).toHaveLength(2);
    expect(steps[0].command?.action).toBe("openposition");
    expect(steps[0].command?.params.symbol).toBe("BTCUSDT");
    expect(steps[0].delayMs).toBe(0);
    expect(steps[1].command?.action).toBe("closeposition");
  });

  it("parses a fixed `pause=` into a delay with no command", () => {
    const steps = parseMessageSet("pause=500 :: action=openposition;symbol=ETHUSDT;qty=2");
    expect(steps).toHaveLength(2);
    expect(steps[0].command).toBeUndefined();
    expect(steps[0].delayMs).toBe(500);
    expect(steps[1].delayMs).toBe(0);
    expect(steps[1].command?.action).toBe("openposition");
  });

  it("resolves `randpause=a-b` into a delay within [a, b]", () => {
    for (let i = 0; i < 25; i += 1) {
      const [step] = parseMessageSet("randpause=100-200");
      expect(step.command).toBeUndefined();
      expect(step.delayMs).toBeGreaterThanOrEqual(100);
      expect(step.delayMs).toBeLessThanOrEqual(200);
    }
  });

  it("keeps a pause on the SAME step as its command (`;`-joined)", () => {
    const [step] = parseMessageSet("pause=250;action=openposition;symbol=BTCUSDT;qty=1");
    expect(step.delayMs).toBe(250);
    expect(step.command?.action).toBe("openposition");
  });

  it("trims whitespace and drops empty chained segments", () => {
    const steps = parseMessageSet("  action=openposition;symbol=btcusdt;qty=1  ::   ");
    expect(steps).toHaveLength(1);
    expect(steps[0].command?.action).toBe("openposition");
  });
});

describe("parseCommands", () => {
  it("returns only the commands, ignoring pause-only steps", () => {
    const cmds = parseCommands("pause=300 :: action=openposition;symbol=BTCUSDT;qty=1");
    expect(cmds).toHaveLength(1);
    expect(cmds[0].action).toBe("openposition");
  });

  it("defaults to `neworder` when no action is given", () => {
    const [cmd] = parseCommands("symbol=BTCUSDT;side=buy;qty=1");
    expect(cmd.action).toBe("neworder");
    expect(cmd.params.symbol).toBe("BTCUSDT");
    expect(cmd.params.side).toBe("buy");
    expect(cmd.params.qty).toBe("1");
  });

  it("supports the `action=SYMBOL` shorthand (e.g. `openposition=BTCUSDT`)", () => {
    const [cmd] = parseCommands("openposition=BTCUSDT;qty=1");
    expect(cmd.action).toBe("openposition");
    expect(cmd.params.symbol).toBe("BTCUSDT");
  });

  it("maps action aliases (entry -> openposition, exit -> closeposition)", () => {
    expect(parseCommands("entry;symbol=BTCUSDT;qty=1")[0].action).toBe("openposition");
    expect(parseCommands("exit;symbol=BTCUSDT")[0].action).toBe("closeposition");
    expect(parseCommands("reverse;symbol=BTCUSDT;qty=1")[0].action).toBe("turnover");
    expect(parseCommands("closeall")[0].action).toBe("exitallpositions");
  });
});

describe("commandToExec — resolved ExecOrder fields", () => {
  it("resolves openposition (entry) with side, qty, leverage", () => {
    const [cmd] = parseCommands("action=openposition;symbol=BTCUSDT;side=long;qty=0.5;lev=10");
    const exec = commandToExec(cmd);
    expect(exec.action).toBe("open");
    expect(exec.market).toBe("futures");
    expect(exec.symbol).toBe("BTCUSDT");
    expect(exec.side).toBe("buy"); // long -> buy
    expect(exec.qty).toBe(0.5);
    expect(exec.leverage).toBe(10);
    expect(exec.type).toBe("market");
    expect(exec.reduceOnly).toBe(false);
    expect(exec.reason).toBe("command");
  });

  it("resolves closeposition to a reduce-only close", () => {
    const [cmd] = parseCommands("action=closeposition;symbol=BTCUSDT;closepro=50");
    const exec = commandToExec(cmd);
    expect(exec.action).toBe("close");
    expect(exec.closePct).toBe(50);
  });

  it("resolves a newlimitorder with price and TIF", () => {
    const [cmd] = parseCommands("symbol=ETHUSDT;side=buy;type=limit;price=1800;qty=2;tif=GTC");
    const exec = commandToExec(cmd);
    expect(exec.action).toBe("neworder");
    expect(exec.type).toBe("limit");
    expect(exec.price).toBe(1800);
    expect(exec.qty).toBe(2);
    expect(exec.tif).toBe("GTC");
    expect(exec.side).toBe("buy");
  });

  it("resolves a stop-market order via stop synonyms (stopprice -> trgprice)", () => {
    const [cmd] = parseCommands("symbol=BTCUSDT;side=sell;type=stop_market;stopprice=25000;qty=1");
    const exec = commandToExec(cmd);
    expect(exec.type).toBe("stop_market");
    expect(exec.trgPrice).toBe(25000);
    expect(exec.side).toBe("sell");
  });

  it("resolves an attached stop spec (percent basis)", () => {
    const [cmd] = parseCommands("action=openposition;symbol=BTCUSDT;side=buy;qty=1;stop=2%");
    const exec = commandToExec(cmd);
    expect(exec.stop).toEqual({ basis: "percent", value: 2 });
  });

  it("resolves an attached stop spec (absolute price basis)", () => {
    const [cmd] = parseCommands("action=openposition;symbol=BTCUSDT;side=buy;qty=1;stop=24000");
    const exec = commandToExec(cmd);
    expect(exec.stop).toEqual({ basis: "price", value: 24000 });
  });

  it("honours the `!` flag (sets true) and the `^` flag (sets false)", () => {
    const truthy = commandToExec(parseCommands("symbol=BTCUSDT;side=sell;reduceonly!")[0]);
    expect(truthy.reduceOnly).toBe(true);
    const falsy = commandToExec(parseCommands("symbol=BTCUSDT;side=buy;qty=1;levforqty^")[0]);
    expect(falsy.levForQty).toBe(false);
  });

  it("applies key synonyms (leverage->lev, reduce->reduceonly, market->mktype)", () => {
    const [cmd] = parseCommands("action=openposition;symbol=BTCUSDT;side=buy;qty=1;leverage=5;reduce=true;market=spot");
    const exec = commandToExec(cmd);
    expect(exec.leverage).toBe(5);
    expect(exec.reduceOnly).toBe(true);
    expect(exec.market).toBe("spot");
  });

  it("resolves quantity synonyms (ququantity->quqty, openquantityproc->openpro)", () => {
    const [cmd] = parseCommands("action=openposition;symbol=BTCUSDT;side=buy;ququantity=1000;openquantityproc=25");
    const exec = commandToExec(cmd);
    expect(exec.quoteQty).toBe(1000);
    expect(exec.openPct).toBe(25);
  });

  it("resolves a get command with an uppercased value", () => {
    const [cmd] = parseCommands("get=balance");
    const exec = commandToExec(cmd);
    expect(exec.action).toBe("get");
    expect(exec.getValue).toBe("BALANCE");
  });

  it("resolves a set command", () => {
    const [cmd] = parseCommands("set=leverage;lev=20");
    const exec = commandToExec(cmd);
    expect(exec.action).toBe("set");
    expect(exec.setValue).toBe("LEVERAGE");
    expect(exec.leverage).toBe(20);
  });

  it("resolves cancelorder by= from the shorthand value", () => {
    const [cmd] = parseCommands("cancelorder=side;symbol=BTCUSDT;side=buy");
    const exec = commandToExec(cmd);
    expect(exec.action).toBe("cancel");
    expect(exec.by).toBe("side");
  });
});

describe("parseTpLevels", () => {
  it("parses a single [price,qty] group (percent price, percent qty)", () => {
    const levels = parseTpLevels("[2%,50%]");
    expect(levels).toEqual([
      { priceBasis: "percent", price: 2, qtyBasis: "percent", qty: 50, limitPrice: undefined },
    ]);
  });

  it("parses an absolute price + absolute qty group", () => {
    const levels = parseTpLevels("[26000,1]");
    expect(levels).toEqual([
      { priceBasis: "price", price: 26000, qtyBasis: "abs", qty: 1, limitPrice: undefined },
    ]);
  });

  it("parses a [price,qty,limit] group into a TP-limit level", () => {
    const levels = parseTpLevels("[26000,1,25990]");
    expect(levels?.[0].limitPrice).toBe(25990);
  });

  it("parses multiple comma-joined groups", () => {
    const levels = parseTpLevels("[1%,50%][2%,50%]");
    expect(levels).toHaveLength(2);
    expect(levels?.[0].price).toBe(1);
    expect(levels?.[1].price).toBe(2);
  });

  it("defaults qty to 100 when omitted", () => {
    const levels = parseTpLevels("[2%]");
    expect(levels?.[0].qty).toBe(100);
  });

  it("returns undefined for empty / bracket-less input", () => {
    expect(parseTpLevels("")).toBeUndefined();
    expect(parseTpLevels("nope")).toBeUndefined();
  });

  it("wires parsed TP levels through commandToExec", () => {
    const [cmd] = parseCommands("action=openposition;symbol=BTCUSDT;side=buy;qty=1;tp=[1%,50%][2%,50%]");
    const exec = commandToExec(cmd);
    expect(exec.takeProfits).toHaveLength(2);
    expect(exec.takeProfits?.[0]).toMatchObject({ priceBasis: "percent", price: 1, qty: 50 });
  });
});

describe("formatExec round-trips", () => {
  it("renders an ExecOrder back to a command string that re-parses to the same order", () => {
    // Use a neworder so the rendered `action=` round-trips through the parser
    // (formatExec emits the ExecAction verb; only `neworder` is a parser alias too).
    const original = commandToExec(
      parseCommands("symbol=BTCUSDT;side=buy;type=limit;qty=1.5;price=25000")[0]
    );
    const rendered = formatExec(original);
    // Re-parse the rendered string and compare the fields formatExec emits.
    const reparsed = commandToExec(parseCommands(rendered)[0]);
    expect(reparsed.action).toBe(original.action);
    expect(reparsed.market).toBe(original.market);
    expect(reparsed.symbol).toBe(original.symbol);
    expect(reparsed.side).toBe(original.side);
    expect(reparsed.type).toBe(original.type);
    expect(reparsed.qty).toBe(original.qty);
    expect(reparsed.price).toBe(original.price);
  });

  it("emits the ExecAction verb for non-default actions (e.g. open)", () => {
    const exec = commandToExec(parseCommands("action=openposition;symbol=BTCUSDT;side=buy;qty=1")[0]);
    expect(formatExec(exec)).toContain("action=open");
  });

  it("emits reduceonly! when the flag is set and round-trips it", () => {
    const [cmd] = parseCommands("symbol=BTCUSDT;side=sell;qty=1;reduceonly!");
    const exec = commandToExec(cmd);
    const rendered = formatExec(exec);
    expect(rendered).toContain("reduceonly!");
    const reparsed = commandToExec(parseCommands(rendered)[0]);
    expect(reparsed.reduceOnly).toBe(true);
  });

  it("omits the type field for a plain market order", () => {
    const exec = commandToExec(parseCommands("symbol=BTCUSDT;side=buy;qty=1")[0]);
    // Guard against matching the `mktype=` substring — check for the `;type=` token.
    expect(formatExec(exec)).not.toContain(";type=");
  });
});
