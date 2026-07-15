import type { Locale } from "../i18n";

const en = {
  title: "Fork types",
  summary: "How 2-leg, 3-leg and intra-exchange routes differ",
  pairwiseTitle: "Double / pairwise",
  pairwiseMeta: "2 legs · one or two exchanges",
  pairwiseBody: "Buy one market and sell another. Synchronized books, fees, inventory and collateral still determine whether the displayed difference is usable.",
  triangularTitle: "Triple / triangular",
  triangularMeta: "3 spot legs · one exchange",
  triangularBody: "Convert the start asset through two intermediate markets and back. Fees, depth, lot rounding and partial fills apply after every leg.",
  intraTitle: "Intra-exchange",
  intraMeta: "same venue · 2 or more legs",
  intraBody: "A location, not a separate strategy: it may be spot/perpetual basis, a calendar spread, a native spread or a triangular cycle. Separate orders are not automatically atomic.",
  multiTitle: "Multi-leg",
  multiMeta: "4–8 legs · research engine",
  multiBody: "A bounded route search can find longer cycles, but every added leg increases fees, latency, rounding loss and recovery exposure.",
  boundary: "A “fork” is a route hypothesis, not guaranteed profit. Results remain research-only until current depth, account costs, capital and recovery gates pass."
} as const;

type Key = keyof typeof en;

const ru: Record<Key, string> = {
  title: "Типы вилок",
  summary: "Чем отличаются двойные, тройные и внутрибиржевые маршруты",
  pairwiseTitle: "Двойная / парная",
  pairwiseMeta: "2 ноги · одна или две биржи",
  pairwiseBody: "Покупка на одном рынке и продажа на другом. Пригодность разницы всё равно зависит от синхронных стаканов, комиссий, инвентаря и обеспечения.",
  triangularTitle: "Тройная / треугольная",
  triangularMeta: "3 спот-ноги · одна биржа",
  triangularBody: "Стартовый актив проходит через два промежуточных рынка и возвращается обратно. После каждой ноги учитываются комиссии, глубина, округление лота и частичное исполнение.",
  intraTitle: "Внутрибиржевая",
  intraMeta: "одна биржа · 2 и более ног",
  intraBody: "Это место исполнения, а не отдельная стратегия: так могут работать спот/perpetual basis, календарный или нативный спред и треугольный цикл. Раздельные ордера не становятся атомарными автоматически.",
  multiTitle: "Многоногая",
  multiMeta: "4–8 ног · исследовательский движок",
  multiBody: "Ограниченный поиск находит длинные циклы, но каждая новая нога увеличивает комиссии, задержку, потери округления и риск восстановления.",
  boundary: "«Вилка» — гипотеза маршрута, а не гарантированная прибыль. Результат остаётся исследовательским, пока не пройдены проверки актуальной глубины, счётных расходов, капитала и восстановления."
};

const kk: Record<Key, string> = {
  title: "Айырма бағыттарының түрлері",
  summary: "Екі аяқты, үш аяқты және бір биржалық бағыттардың айырмасы",
  pairwiseTitle: "Қос / жұптық",
  pairwiseMeta: "2 аяқ · бір немесе екі биржа",
  pairwiseBody: "Бір нарықтан сатып алып, екіншісінде сату. Айырманың жарамдылығы синхронды стакандарға, комиссияға, қор мен кепілге тәуелді.",
  triangularTitle: "Үштік / үшбұрышты",
  triangularMeta: "3 spot аяқ · бір биржа",
  triangularBody: "Бастапқы актив екі аралық нарықтан өтіп, қайта оралады. Әр аяқтан кейін комиссия, тереңдік, лотты дөңгелектеу және жартылай орындалу есептеледі.",
  intraTitle: "Биржа ішіндегі",
  intraMeta: "бір биржа · 2 немесе одан көп аяқ",
  intraBody: "Бұл жеке стратегия емес, орындалу орны: spot/perpetual basis, күнтізбелік не native spread және үшбұрышты цикл болуы мүмкін. Бөлек order-лер автоматты түрде атомдық болмайды.",
  multiTitle: "Көп аяқты",
  multiMeta: "4–8 аяқ · зерттеу қозғалтқышы",
  multiBody: "Шектелген іздеу ұзын циклдерді табады, бірақ әр қосымша аяқ комиссияны, кідірісті, дөңгелектеу шығынын және қалпына келтіру тәуекелін арттырады.",
  boundary: "«Айырма бағыты» — кепілденген пайда емес, маршрут гипотезасы. Өзекті тереңдік, аккаунт шығыны, капитал және қалпына келтіру тексерілгенше нәтиже тек зерттеу үшін қалады."
};

const messages: Record<Locale, Record<Key, string>> = { en, ru, kk };

export function forkGuideText(locale: Locale, key: Key): string {
  return messages[locale][key];
}
