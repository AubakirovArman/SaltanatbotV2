import type { Locale } from "../../i18n";
import { tradingCancelOrder, tradingFillCount, tradingLocale, tradingTerm, tradingText } from "../../i18n/trading";
import type { Fill, LogRow, OrderJournal, PendingOrder } from "../tradeClient";

interface BotActivityProps {
  symbol: string;
  orders: PendingOrder[];
  orderJournal: OrderJournal[];
  fills: Fill[];
  logs: LogRow[];
  onCommand: (command: string) => Promise<void>;
  locale: Locale;
}

export function BotActivity({ symbol, orders, orderJournal, fills, logs, onCommand, locale }: BotActivityProps) {
  return (
    <>
      {orders.length > 0 && (
        <section className="trade-orders" aria-labelledby="open-orders-title">
          <div className="panel-header small"><strong id="open-orders-title">{tradingText(locale, "openOrders")}</strong><span>{orders.length}</span></div>
          <div className="trade-order-list">
            {orders.map((order) => (
              <div className="trade-order-row" key={order.id}>
                <span className={`order-type ${order.type.includes("stop") ? "down" : order.type.includes("tp") ? "up" : ""}`}>{tradingTerm(locale, order.type)}</span>
                <span className={order.side === "buy" ? "up" : "down"}>{tradingTerm(locale, order.side)}</span>
                <span className="num">{order.qty}</span><span className="num">{order.price ?? order.trgPrice ?? "—"}</span>
                <button type="button" className="order-cancel" aria-label={tradingCancelOrder(locale, tradingTerm(locale, order.type), order.id)} onClick={() => void onCommand(`action=cancelorder;by=id;orderid=${order.id};symbol=${symbol}`)}>×</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {orderJournal.length > 0 && (
        <section className="trade-orders trade-order-journal" aria-labelledby="order-journal-title">
          <div className="panel-header small"><strong id="order-journal-title">{tradingText(locale, "orderJournal")}</strong><span>{orderJournal.length}</span></div>
          <div className="trade-table-scroll">
            <table className="trade-data-table">
              <caption className="sr-only">{tradingText(locale, "orderJournal")}</caption>
              <thead><tr><th scope="col">{tradingText(locale, "time")}</th><th scope="col">{tradingText(locale, "status")}</th><th scope="col">{tradingText(locale, "action")}</th><th scope="col">{tradingText(locale, "side")}</th><th scope="col">{tradingText(locale, "quantity")}</th><th scope="col">{tradingText(locale, "reason")}</th></tr></thead>
              <tbody>{orderJournal.slice(0, 40).map((order) => (
                <tr key={order.id}>
                  <td>{formatTime(order.updatedAt, locale)}</td><td><span className={orderStatusTone(order.status)} data-order-status={order.status}>{tradingTerm(locale, order.status)}</span></td>
                  <td>{tradingTerm(locale, order.action)}</td><td className={order.side === "buy" ? "up" : order.side === "sell" ? "down" : ""}>{tradingTerm(locale, order.side ?? "flat")}</td>
                  <td>{order.filledQty !== undefined ? `${order.filledQty}/${order.qty ?? "?"}` : order.qty ?? "-"}</td><td>{order.reason.replace("signal:", "")}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}

      <section className="trade-journal" aria-labelledby="fill-journal-title">
        <div className="panel-header small"><strong id="fill-journal-title">{tradingText(locale, "journal")}</strong><span>{tradingFillCount(locale, fills.length)}</span></div>
        <div className="trade-table-scroll">
          <table className="trade-data-table">
            <caption className="sr-only">{tradingText(locale, "journal")}</caption>
            <thead><tr><th scope="col">{tradingText(locale, "time")}</th><th scope="col">{tradingText(locale, "side")}</th><th scope="col">{tradingText(locale, "quantity")}</th><th scope="col">{tradingText(locale, "price")}</th><th scope="col">{tradingText(locale, "fee")}</th><th scope="col">{tradingText(locale, "pnl")}</th><th scope="col">{tradingText(locale, "reason")}</th></tr></thead>
            <tbody>{fills.slice(0, 60).map((fill) => (
              <tr key={fill.id}><td>{formatTime(fill.ts, locale)}</td><td className={fill.side === "buy" ? "up" : "down"}>{tradingTerm(locale, fill.side)}</td><td>{fill.qty}</td><td>{fill.price}</td><td>{fill.fee} {fill.feeAsset ?? ""}</td><td className={fill.realizedPnl >= 0 ? "up" : "down"}>{fill.kind === "open" ? "—" : fill.realizedPnl.toFixed(2)}</td><td>{fill.reason.replace("signal:", "")}</td></tr>
            ))}</tbody>
          </table>
          {fills.length === 0 && <p className="empty-note">{tradingText(locale, "noFills")}</p>}
        </div>
        <div className="trade-logs" aria-label={tradingText(locale, "botLogs")}>
          {logs.slice(0, 30).map((log, index) => <div key={`${log.ts}-${index}`} className={`trade-log ${log.level}`}><time>{formatTime(log.ts, locale)}</time>{log.message}</div>)}
        </div>
      </section>
    </>
  );
}

function formatTime(timestamp: number, locale: Locale) {
  return new Date(timestamp).toLocaleTimeString(tradingLocale(locale), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function orderStatusTone(status: OrderJournal["status"]): string {
  if (status === "accepted" || status === "filled" || status === "replaced" || status === "cancelled") return "up";
  if (status === "rejected" || status === "unknown" || status === "expired") return "down";
  return "";
}
