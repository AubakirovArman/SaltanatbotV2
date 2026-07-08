export interface CommandExample {
  label: string;
  command: string;
}

export interface CommandGroup {
  title: string;
  items: CommandExample[];
}

/**
 * Antares command cheatsheet shown in the Trading console. `{sym}` is replaced
 * with the bot's symbol when inserted. Covers all 14 actions.
 */
export const COMMAND_REFERENCE: CommandGroup[] = [
  {
    title: "Market & limit orders (neworder)",
    items: [
      { label: "Market buy 0.1", command: "mktype=futures;symbol={sym};side=buy;type=market;qty=0.1;lev=5" },
      { label: "Market buy 25% of balance", command: "mktype=futures;symbol={sym};side=buy;type=market;openpro=25;lev=10;levforqty!" },
      { label: "Limit buy at price", command: "mktype=futures;symbol={sym};side=buy;type=limit;price=30000;qty=0.1" },
      { label: "Reduce-only close 50%", command: "mktype=futures;symbol={sym};side=sell;type=market;closepro=50;reduceonly!" }
    ]
  },
  {
    title: "Positions",
    items: [
      { label: "Open long + stop + 2 TP", command: "action=openposition;symbol={sym};side=buy;openpro=10;lev=10;levforqty!;stop=5%;tp=[3%,50%][6%,50%]" },
      { label: "Open short (quote 100)", command: "action=openposition;symbol={sym};side=sell;quqty=100;lev=5;levforqty!;stop=3%" },
      { label: "Close position (100%)", command: "action=closeposition;symbol={sym}" },
      { label: "Close 50%", command: "closeposition={sym};closepro=50" },
      { label: "Reverse position", command: "action=turnover;symbol={sym};side=sell;qty=0.1;lev=5" },
      { label: "Close ALL positions", command: "action=exitallpositions;mktype=futures" }
    ]
  },
  {
    title: "Protection (stop / take-profit)",
    items: [
      { label: "Change SL & TP on position", command: "action=chporders;symbol={sym};stop=2%;tp=[3%,50%][6%,50%]" },
      { label: "Stop-market -4%", command: "mktype=futures;symbol={sym};side=sell;type=stop_market;closepro=100;trgpricepro=-4" },
      { label: "Take-profit +5%", command: "mktype=futures;symbol={sym};side=sell;type=tp_market;closepro=50;trgpricepro=5" }
    ]
  },
  {
    title: "Advanced entries",
    items: [
      { label: "Limit entry + protection", command: "action=openorders;symbol={sym};side=buy;price=30000;qty=0.1;stop=3%;tp=[32000,100%]" },
      { label: "Spread entry (ladder)", command: "action=spreadentry;symbol={sym};side=buy;qty=0.3;price=30000;spreadperc=1.5;spreadcount=3;stop=2%" }
    ]
  },
  {
    title: "Orders management",
    items: [
      { label: "Cancel all orders", command: "action=cancelall;symbol={sym};mktype=futures" },
      { label: "Cancel by symbol", command: "action=cancelorder;by=symbol;symbol={sym}" },
      { label: "Cancel orphan SL/TP", command: "action=cancelorphans;mktype=futures" }
    ]
  },
  {
    title: "Info & settings",
    items: [
      { label: "Get balance", command: "get=BALANCE;mktype=futures" },
      { label: "Get position", command: "get=POSITIONS;symbol={sym};mktype=futures" },
      { label: "Set leverage 10x", command: "set=LEVERAGE;symbol={sym};lev=10;mktype=futures" },
      { label: "Enable isolated margin", command: "set=ISOLATEDMARGIN;symbol={sym};isisolated=true;mktype=futures" }
    ]
  },
  {
    title: "Chaining & pauses",
    items: [
      { label: "Close → wait → reverse", command: "closepos=symbol;symbol={sym}::pause=500::mktype=futures;symbol={sym};side=sell;type=market;openpro=100;lev=5" }
    ]
  }
];
