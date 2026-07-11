import type { Fill, LogRow, OrderJournal, PendingOrder } from "../tradeClient";

interface BotActivityProps {
  symbol: string;
  orders: PendingOrder[];
  orderJournal: OrderJournal[];
  fills: Fill[];
  logs: LogRow[];
  onCommand: (command: string) => Promise<void>;
}

export function BotActivity({ symbol, orders, orderJournal, fills, logs, onCommand }: BotActivityProps) {
  return (
    <>
      {orders.length > 0 && (
        <section className="trade-orders" aria-labelledby="open-orders-title">
          <div className="panel-header small"><strong id="open-orders-title">Open orders</strong><span>{orders.length}</span></div>
          <div className="trade-order-list">
            {orders.map((order) => (
              <div className="trade-order-row" key={order.id}>
                <span className={`order-type ${order.type.includes("stop") ? "down" : order.type.includes("tp") ? "up" : ""}`}>{order.type.replace("_", " ")}</span>
                <span className={order.side === "buy" ? "up" : "down"}>{order.side}</span>
                <span className="num">{order.qty}</span><span className="num">{order.price ?? order.trgPrice ?? "—"}</span>
                <button type="button" className="order-cancel" aria-label={`Cancel ${order.type} order ${order.id}`} onClick={() => void onCommand(`action=cancelorder;by=id;orderid=${order.id};symbol=${symbol}`)}>×</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {orderJournal.length > 0 && (
        <section className="trade-orders trade-order-journal" aria-labelledby="order-journal-title">
          <div className="panel-header small"><strong id="order-journal-title">Order journal</strong><span>{orderJournal.length}</span></div>
          <div className="trade-table-scroll">
            <table className="trade-data-table">
              <thead><tr><th>Time</th><th>Status</th><th>Action</th><th>Side</th><th>Qty</th><th>Reason</th></tr></thead>
              <tbody>{orderJournal.slice(0, 40).map((order) => (
                <tr key={order.id}>
                  <td>{formatTime(order.updatedAt)}</td><td className={order.status === "accepted" ? "up" : order.status === "rejected" ? "down" : ""}>{order.status}</td>
                  <td>{order.action}</td><td className={order.side === "buy" ? "up" : order.side === "sell" ? "down" : ""}>{order.side ?? "flat"}</td>
                  <td>{order.qty ?? "-"}</td><td>{order.reason.replace("signal:", "")}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}

      <section className="trade-journal" aria-labelledby="fill-journal-title">
        <div className="panel-header small"><strong id="fill-journal-title">Journal</strong><span>{fills.length} fills</span></div>
        <div className="trade-table-scroll">
          <table className="trade-data-table">
            <thead><tr><th>Time</th><th>Side</th><th>Qty</th><th>Price</th><th>PnL</th><th>Reason</th></tr></thead>
            <tbody>{fills.slice(0, 60).map((fill) => (
              <tr key={fill.id}><td>{formatTime(fill.ts)}</td><td className={fill.side === "buy" ? "up" : "down"}>{fill.side}</td><td>{fill.qty}</td><td>{fill.price}</td><td className={fill.realizedPnl >= 0 ? "up" : "down"}>{fill.kind === "open" ? "—" : fill.realizedPnl.toFixed(2)}</td><td>{fill.reason.replace("signal:", "")}</td></tr>
            ))}</tbody>
          </table>
          {fills.length === 0 && <p className="empty-note">No fills yet.</p>}
        </div>
        <div className="trade-logs" aria-label="Bot logs">
          {logs.slice(0, 30).map((log, index) => <div key={`${log.ts}-${index}`} className={`trade-log ${log.level}`}><time>{formatTime(log.ts)}</time>{log.message}</div>)}
        </div>
      </section>
    </>
  );
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
