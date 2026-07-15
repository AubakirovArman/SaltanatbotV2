import type { Locale } from "../i18n";

export interface CommandExample {
  label: string;
  command: string;
}

export interface CommandGroup {
  title: string;
  items: CommandExample[];
}

type Localized = Record<Locale, string>;
interface LocalizedGroup {
  title: Localized;
  items: Array<{ label: Localized; command: string }>;
}

const text = (en: string, ru: string, kk: string): Localized => ({ en, ru, kk });

/** Antares command cheatsheet. Command syntax stays language-neutral. */
const groups: LocalizedGroup[] = [
  {
    title: text("Market & limit orders (neworder)", "Рыночные и лимитные ордера (neworder)", "Нарықтық және лимиттік ордерлер (neworder)"),
    items: [
      { label: text("Market buy 0.1", "Рыночная покупка 0,1", "Нарықтан 0,1 сатып алу"), command: "mktype=futures;symbol={sym};side=buy;type=market;qty=0.1;lev=5" },
      { label: text("Paper-only: buy 25% of balance", "Только paper: покупка на 25% баланса", "Тек paper: баланстың 25%-ына сатып алу"), command: "mktype=futures;symbol={sym};side=buy;type=market;openpro=25;lev=10;levforqty!" },
      { label: text("Limit buy at price", "Лимитная покупка по цене", "Баға бойынша лимиттік сатып алу"), command: "mktype=futures;symbol={sym};side=buy;type=limit;price=30000;qty=0.1" },
      { label: text("Reduce-only close 50%", "Закрыть 50% в reduce-only", "Reduce-only арқылы 50% жабу"), command: "mktype=futures;symbol={sym};side=sell;type=market;closepro=50;reduceonly!" }
    ]
  },
  {
    title: text("Positions", "Позиции", "Позициялар"),
    items: [
      { label: text("Open long + stop + 2 TP", "Открыть лонг + стоп + 2 TP", "Лонг + стоп + 2 TP ашу"), command: "action=openposition;symbol={sym};side=buy;qty=0.1;lev=10;stop=5%;tp=[3%,50%][6%,50%]" },
      { label: text("Open short (0.1 base)", "Открыть шорт (0,1 базового актива)", "Шорт ашу (0,1 базалық актив)"), command: "action=openposition;symbol={sym};side=sell;qty=0.1;lev=5;stop=3%" },
      { label: text("Close position (100%)", "Закрыть позицию (100%)", "Позицияны жабу (100%)"), command: "action=closeposition;symbol={sym}" },
      { label: text("Close 50%", "Закрыть 50%", "50% жабу"), command: "closeposition={sym};closepro=50" },
      { label: text("Close, wait, then open short", "Закрыть, подождать, затем открыть шорт", "Жабу, күту, кейін шорт ашу"), command: "action=closeposition;symbol={sym}::pause=500::action=openposition;mktype=futures;symbol={sym};side=sell;type=market;qty=0.1;lev=5" },
      { label: text("Close ALL positions", "Закрыть ВСЕ позиции", "БАРЛЫҚ позицияны жабу"), command: "action=exitallpositions;mktype=futures" }
    ]
  },
  {
    title: text("Protection (stop / take-profit)", "Защита (стоп / тейк-профит)", "Қорғаныс (стоп / тейк-профит)"),
    items: [
      { label: text("Change SL & TP on position", "Изменить SL и TP позиции", "Позицияның SL және TP мәндерін өзгерту"), command: "action=chporders;symbol={sym};stop=2%;tp=[3%,50%][6%,50%]" },
      { label: text("Stop-market -4%", "Стоп-маркет −4%", "Стоп-маркет −4%"), command: "mktype=futures;symbol={sym};side=sell;type=stop_market;closepro=100;trgpricepro=-4" },
      { label: text("Take-profit +5%", "Тейк-профит +5%", "Тейк-профит +5%"), command: "mktype=futures;symbol={sym};side=sell;type=tp_market;closepro=50;trgpricepro=5" }
    ]
  },
  {
    title: text("Advanced entries", "Расширенные входы", "Кеңейтілген кірулер"),
    items: [
      { label: text("Limit entry + protection", "Лимитный вход + защита", "Лимиттік кіру + қорғаныс"), command: "action=openorders;symbol={sym};side=buy;price=30000;qty=0.1;stop=3%;tp=[32000,100%]" },
      { label: text("Spread entry (ladder)", "Вход лесенкой", "Сатылы кіру"), command: "action=spreadentry;symbol={sym};side=buy;qty=0.3;price=30000;spreadperc=1.5;spreadcount=3;stop=2%" }
    ]
  },
  {
    title: text("Orders management", "Управление ордерами", "Ордерлерді басқару"),
    items: [
      { label: text("Cancel all orders", "Отменить все ордера", "Барлық ордерді болдырмау"), command: "action=cancelall;symbol={sym};mktype=futures" },
      { label: text("Cancel by symbol", "Отменить по символу", "Символ бойынша болдырмау"), command: "action=cancelorder;by=symbol;symbol={sym}" },
      { label: text("Cancel orphan SL/TP", "Отменить осиротевшие SL/TP", "Жетім SL/TP ордерлерін болдырмау"), command: "action=cancelorphans;mktype=futures" }
    ]
  },
  {
    title: text("Info & settings", "Информация и настройки", "Ақпарат және параметрлер"),
    items: [
      { label: text("Get balance", "Получить баланс", "Балансты алу"), command: "get=BALANCE;mktype=futures" },
      { label: text("Get position", "Получить позицию", "Позицияны алу"), command: "get=POSITIONS;symbol={sym};mktype=futures" },
      { label: text("Set leverage 10x", "Установить плечо 10x", "10x иінтірек орнату"), command: "set=LEVERAGE;symbol={sym};lev=10;mktype=futures" },
      { label: text("Enable isolated margin", "Включить изолированную маржу", "Оқшауланған маржаны қосу"), command: "set=ISOLATEDMARGIN;symbol={sym};isisolated=true;mktype=futures" }
    ]
  },
  {
    title: text("Chaining & pauses", "Цепочки и паузы", "Тізбектер және үзілістер"),
    items: [{ label: text("Close → wait → explicit entry", "Закрыть → подождать → явный вход", "Жабу → күту → нақты кіру"), command: "closepos=symbol;symbol={sym}::pause=500::mktype=futures;symbol={sym};side=sell;type=market;qty=0.1;lev=5" }]
  }
];

export function commandReference(locale: Locale): CommandGroup[] {
  return groups.map((group) => ({
    title: group.title[locale],
    items: group.items.map((item) => ({ label: item.label[locale], command: item.command }))
  }));
}
