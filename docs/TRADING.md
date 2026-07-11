# Trading & the Antares-style command language

The Trade tab drives every SaltanatbotV2 bot through a single, exchange-agnostic instruction pipeline: an **Antares-style command string** is parsed into structured steps, each step is normalised into an `ExecOrder`, and that order is executed by an **exchange adapter**. Three adapters implement the same interface — a fully simulated **paper** engine (the default), plus live **Binance** and **Bybit** adapters that talk to the real REST APIs with HMAC-signed requests. This document describes the command language exactly as implemented in `backend/src/trading/commands.ts`, the three execution modes, notifications, and how API keys are encrypted at rest. **Paper mode is the default; live trading only happens when you supply your own API keys, which are encrypted at rest and never returned to the browser.**

---

## 1. The command language

Manual commands are entered on the Trade tab and executed against a running bot via `TradingEngine.manualCommand()`, which calls `parseMessageSet()` and runs the resulting steps in order.

### 1.1 Three-level grammar

```
messageset := command ( "::" command )*      // "::" chains commands
command    := param ( ";" param )*           // ";" separates params
param      := key=value | flag! | flag^ | pause=ms | randpause=a-b
```

| Separator | Meaning |
| --- | --- |
| `;` (or a newline) | Separates parameters **within** one command. |
| `::` | Chains commands. Each chained command runs strictly in sequence. |

Parsing is done by `parseMessageSet()`, which splits on `::`, trims, drops empty parts, and parses each segment into a `CommandStep { command?, delayMs }`.

### 1.2 `param=value` syntax and the default action

Each parameter is a `key=value` pair. Keys and enum values are lower-cased before matching, so the parser is case-insensitive. If no `action` is given, the action defaults to **`neworder`**. These two are equivalent:

```text
mktype=spot;symbol=XRPUSDT;side=buy;type=market;qty=20
action=neworder;mktype=spot;symbol=XRPUSDT;side=buy;type=market;qty=20
```

Legacy key synonyms are normalised automatically (`normalizeKey`):

| Legacy key | Canonical |
| --- | --- |
| `leverage` | `lev` |
| `ququantity` | `quqty` |
| `openquantityproc` | `openpro` |
| `closequantityproc` | `closepro` |
| `priceproc` | `pricepro` |
| `stoppriceproc` | `trgpricepro` |
| `stopprice` | `trgprice` |
| `clientorderid` | `clientid` |
| `reduce` | `reduceonly` |
| `market` | `mktype` |

### 1.3 The `!` and `^` boolean flags

A trailing `!` means **true**, a trailing `^` means **false**. This works both as a bare flag and appended to a value:

```text
reduceonly!        →  reduceonly=true
dualside^          →  dualside=false
```

These map to the truthy/falsy fields in `ExecOrder`. A value is treated as truthy (`truthy()`) when it equals `true`, `1`, or `yes`. Flags recognised by `commandToExec()` include: `levforqty`, `reduceonly` (and `closeposition`, which also forces `reduceOnly`), `dualside`, `isisolated`, `ignoreside`, `upsert`, `forcereplace`, `includelimit`, and `clearstage`.

### 1.4 `pause` and `randpause`

Delay directives are handled per step by `parseStep()`. They set the step's `delayMs`, which the engine applies **after** the step's command runs:

| Directive | Effect |
| --- | --- |
| `pause=1000` | Fixed 1000 ms delay. |
| `randpause=300-900` | Random delay drawn uniformly from `[a, b]` inclusive (the upper bound is clamped to be ≥ the lower bound). |

The engine caps any single delay at **10 000 ms** (`Math.min(step.delayMs, 10_000)`). A typical manual reversal uses a pause to let margin free up between closing and re-opening:

```text
mktype=futures;symbol=ETHUSDT;side=buy;type=market;closepro=100;reduceonly!::pause=500;mktype=futures;symbol=ETHUSDT;side=sell;type=market;openpro=100;lev=2
```

### 1.5 Action aliases and shorthands

`action=` selects the operation, but several friendly aliases resolve to the same action (`ACTION_ALIASES`), e.g. `order → neworder`, `entry → openposition`, `exit`/`exitposition`/`closepos → closeposition`, `exitall`/`closeall`/`closeallpositions → exitallpositions`, `reverse → turnover`, `cancelallorders → cancelall`, `setvalue → set`.

Some actions accept a shorthand where the action keyword itself carries a value (`parseOne()`):

| Shorthand | Expands to |
| --- | --- |
| `closepos=XRPUSDT` | `action=closeposition;symbol=XRPUSDT` |
| `get=BALANCE` | `action=get;value=BALANCE` |
| `set=LEVERAGE` | `action=set;value=LEVERAGE` |
| `cancelorder=symbol` | `action=cancelorder;by=symbol` |

For most actions, a bare `action=SYMBOL` form sets `symbol` (upper-cased) unless the value is literally `symbol`.

---

## 2. Supported actions

`CommandAction` covers the fourteen Antares actions. Each is mapped to an internal `ExecAction` by `mapAction()` and interpreted by the adapter. The table below reflects the behaviour implemented in the **paper** adapter (`exchange/paper.ts`), which is the reference implementation; the live adapters implement a subset (see §4).

| Action (aliases) | Internal | What it does |
| --- | --- | --- |
| `neworder` (`order`) | `neworder` | Create an order. A `type=market` order fills immediately; if `reduceonly` or `closepro` is set it is routed to `close`. Any other `type` rests in the book until triggered. |
| `openposition` (`entry`) | `open` | Market-open a position and attach reduce-only protection (`stop`, `tp`). Fails if already in a position on the symbol unless `clearstage` is set. |
| `closeposition` (`exit`, `exitposition`, `closepos`) | `close` | Close a position fully or partially. Size = `qty`, else `closepro` %, else 100 %. Side is derived from the open position. |
| `exitallpositions` (`exitall`, `closeall`, `closeallpositions`) | `flatten` | Market-close the position and clear the entire order book. |
| `openorders` | `openorders` | Place a resting **limit** entry plus reduce-only protective stop/TP that act once it fills. `type` is forced to `limit`. |
| `spreadentry` | `spreadentry` | Open one market slice immediately, then place `spreadcount - 1` limit orders spread across `spreadperc` % of a base price. |
| `chporders` | `chporders` | Replace SL/TP of an **existing** position without closing it. Changing the stop clears existing stop orders; changing TP clears existing TP orders. |
| `turnover` (`reverse`) | `turnover` | Reverse the position: close the current side and open the opposite. Errors on a same-direction position unless `ignoreside` is set. |
| `cancelorder` | `cancel` | Cancel resting orders by selector `by` ∈ {`symbol`, `side`, `type`, `id`, `all`}. Defaults to `id` when an id is supplied, else `symbol`. |
| `cancelall` (`cancelallorders`) | `cancelall` | Cancel all resting orders (for `symbol` if given, otherwise the whole book). Positions are untouched. |
| `cancelorphans` | `cancelorphans` | Cancel protective SL/TP orders left with no open position. `includelimit!` also cancels resting `limit` orders. No-op while a position is open. |
| `replaceorder` | `replace` | Modify a resting order matched by `orderid` or `clientid` (side/price/qty/trgprice). With `upsert!`, creates the order if not found. |
| `get` | `get` | Read data: `PRICE`/`SYMPRICE`, `OPENPOS`/`POSITIONS`, `ORDERS`, `DUALSIDE`/`POSITIONMODE`, else account balance/equity (`BALANCE`). |
| `set` | `set` | Set an account/position parameter: `LEVERAGE`, `DUALSIDE` (hedge mode), `ISOLATEDMARGIN`. |

### 2.1 Order-parameter reference

These parameters populate `ExecOrder` via `commandToExec()`:

| Param | Field | Meaning |
| --- | --- | --- |
| `mktype` | `market` | `spot` or `futures` (default `futures`; anything other than `spot` is treated as futures). |
| `symbol` | `symbol` | Trading pair, upper-cased. Falls back to the bot's symbol if omitted. |
| `side` | `side` | `buy`/`long` → `buy`; `sell`/`short` → `sell`. |
| `type` | `type` | `market`, `limit`, `stop_market`, `stop_limit`, `tp_market`, `tp_limit` (default `market`). |
| `qty` | `qty` | Absolute base quantity. |
| `quqty` | `quoteQty` | Quote-denominated size (converted to base by the adapter). |
| `openpro` | `openPct` | % of free balance to open with. |
| `closepro` | `closePct` | % of position to close. |
| `depopro` | `depoPct` | % of total deposit to open with. |
| `lev` | `leverage` | Leverage. |
| `levforqty` | `levForQty` | Multiply the computed quantity by leverage. |
| `reduceonly` | `reduceOnly` | Reduce-only (no reversal). Also set when `closeposition` is truthy. |
| `price` | `price` | Limit price. |
| `trgprice` | `trgPrice` | Trigger price for stop/TP. |
| `pricepro` | `pricePro` | Limit price as ± % of mark. |
| `trgpricepro` | `trgPricePro` | Trigger as ± % of mark. |
| `tif` | `tif` | `GTC`, `IOC`, or `FOK`. |
| `clientid` | `clientId` | Client order id. |
| `orderid` | `orderId` | Exchange order id (for replace/cancel). |
| `by` | `by` | Cancel selector (`order` is normalised to `id`). |
| `stop` | `stop` | Stop level: `stop=5%` (percent basis) or `stop=29000` (absolute price). |
| `tp` | `takeProfits` | One or more TP levels — see §2.2. |
| `spreadperc` | `spreadPerc` | Spread width % for `spreadentry`. |
| `spreadcount` | `spreadCount` | Number of orders (incl. the market slice) for `spreadentry`. |
| `value` | `getValue`/`setValue` | Target of `get`/`set` (upper-cased). |

### 2.2 Take-profit levels

TP levels are parsed by `parseTpLevels()` from bracket groups, accepted both back-to-back and comma-separated: `tp=[10%,40%][25000,0.001]` or `tp=[10%,40%],[25000,0.001]`. Each group is `[price,qty]` with an optional third element `[price,qty,limit]`:

- A `%` on the price makes it a **percent** basis (offset from the entry price); otherwise it is an absolute price.
- A `%` on the qty makes it a **percent** of the position; otherwise it is an absolute base amount. Omitting the qty defaults to 100 %.
- Supplying the third `limit` element makes the level a **TP_LIMIT**; otherwise it is **TP_MARKET**.

Stop basis works the same way in `parseStop()`: a trailing `%` selects percent basis, otherwise the value is an absolute price.

---

## 3. The paper engine (default execution mode)

When a bot's `exchange` is `paper`, `TradingEngine.buildAdapter()` constructs a `PaperAdapter` — a fully simulated exchange with a real order book. It is the default and requires no API keys. Its parameters:

| Setting | Value |
| --- | --- |
| Start balance | `10 000` USDT (or `max(sizeValue * 10, 10 000)` when sizing by quote). |
| Fee | `0.05 %` per fill (`feePct`). |
| Slippage | `0.02 %`, applied against you on entry/exit (`slipPct`). |
| Currency | `USDT`. |

### 3.1 Resting orders and tick-based fills

`neworder` with any non-market type places a `PendingOrder` in the book. On every price tick the engine calls `onPrice()`, which fills any resting order whose trigger/limit condition is crossed (`triggered()`):

| Type | Fills when |
| --- | --- |
| `limit` | buy: price ≤ limit; sell: price ≥ limit. |
| `stop_market` / `stop_limit` | sell-stop: price ≤ trigger; buy-stop: price ≥ trigger. |
| `tp_market` / `tp_limit` | sell-TP: price ≥ trigger; buy-TP: price ≤ trigger. |

Limit and `*_limit` orders fill at their stored `price`; market and `*_market` conditionals fill at the tick price. The engine holds a **single one-way position per symbol**: an opposing fill reduces or closes it (realising PnL net of fees), and once a position is fully closed, any remaining reduce-only protective orders are dropped from the book.

The full paper state — `balance`, `position`, `orders`, `leverage`, `isolated`, `dualSide` — is serialised via `getState()`/`setState()` and persisted to the `paper:<botId>` setting after every fill, so a bot resumes exactly where it left off.

### 3.2 Quantity resolution

`resolveQty()` picks the first source present, in priority order: `qty` → `quqty` (÷ price, × leverage if `levforqty`) → `openpro`/`depopro` (% of balance × leverage ÷ price) → `closepro` (% of the open position).

---

## 4. Live execution — Binance & Bybit

Setting a bot's `exchange` to `binance` or `bybit` builds a live adapter with the stored keys (`keys:binance` / `keys:bybit`). If no keys are stored, the adapter is constructed with empty strings and any signed call throws `"… API keys are not set"` — public price reads still work, but nothing can trade.

Live spot is fail-closed by default while complete inventory/fee-asset accounting remains experimental. Enabling the explicit `ENABLE_LIVE_SPOT` override transfers responsibility to the operator; paper and futures testnet validation should be completed first.

Every mutating live request is journaled before network I/O. A definitive HTTP/API rejection becomes `rejected`; a network failure or HTTP 5xx during POST/DELETE is ambiguous and becomes `unknown`, because the venue may have accepted the request. The engine never blindly resubmits that order. Non-terminal Binance/Bybit orders are checked through bounded signed REST polling every 30 seconds until authenticated private streams are available.

### 4.1 Binance (`exchange/binance.ts`)

- **Markets:** Spot (`api.binance.com`) and USDT-M Futures (`fapi.binance.com`).
- **Signing:** every private call goes through `signed()`, which builds a query string with `timestamp` and `recvWindow=5000`, computes an **HMAC-SHA256** signature with the API secret, appends it as `signature`, and sends the API key in the `X-MBX-APIKEY` header.
- **Orders:** market by default; `limit` sends price + TIF; conditional types send `stopPrice`. On futures, `openposition`/entry can also attach a `STOP_MARKET` (`closePosition`) and `TAKE_PROFIT_MARKET` reduce-only orders. `close`/`flatten` read the live position and market-close the requested `closepro` %.
- **Set:** on futures, `LEVERAGE`, `ISOLATEDMARGIN` (`marginType`), and `DUALSIDE` (`positionSide/dual`) are applied; on spot, `set` is ignored.

### 4.2 Bybit (`exchange/bybit.ts`)

- **Markets:** v5 unified API. `linear` category for USDT futures, `spot` for spot.
- **Signing:** `signed()` builds an **HMAC-SHA256** signature over `timestamp + apiKey + recvWindow + payload` (query string for GET, JSON body for POST) and sends `X-BAPI-API-KEY`, `X-BAPI-TIMESTAMP`, `X-BAPI-RECV-WINDOW`, and `X-BAPI-SIGN` headers with `recvWindow=5000`. A non-zero `retCode` in the response is raised as an error.
- **Orders:** `Market`/`Limit`, with `triggerPrice` + `triggerDirection` for conditionals. `close`/`flatten`/`turnover` read the live position first; `cancel*` uses `order/cancel-all`.
- **Set:** on futures, `LEVERAGE` (`set-leverage`), `ISOLATEDMARGIN` (`switch-isolated`), and `DUALSIDE` (`switch-mode`); ignored on spot.

### 4.3 The strategy-driven path

Beyond manual commands, a running strategy emits entry/exit intents on each closed bar (`onClosedBar()`). Paper entries and live entries with trailing protection keep stop/target management inside the engine (`onTick()`). Live futures entries with fixed stop or target request exchange-side protection so it survives a process/network failure. The adapter must explicitly confirm every requested protection order; otherwise it performs a best-effort emergency close and returns a failed result. Position sizing follows the bot's `sizeMode` when the strategy does not specify a size.

---

## 5. Notifications (Telegram + VK)

`notifications.ts` fires messages to any enabled channel on lifecycle events. The engine calls `notify()` on start, stop, position open, position close (including resting-order fills), and signals/alerts (when `notifyMarkers` is on). Each event has an icon:

| Event | Icon | Fired when |
| --- | --- | --- |
| `start` | ▶️ | Bot started. |
| `stop` | ⏹️ | Bot stopped. |
| `open` | 🟢 | Position opened. |
| `close` | 🔵 | Position closed / reduce-only fill. |
| `error` | ⚠️ | Error condition. |
| `signal` | 🔔 | Marker / alert signal. |

- **Telegram:** POSTs to `api.telegram.org/bot<token>/sendMessage` with the configured `chatId`, `parse_mode: HTML`, and web-page preview disabled. HTML is escaped.
- **VK:** POSTs to `api.vk.com/method/messages.send` with `access_token`, `peerId`, API version `5.199`, and a `random_id`. HTML tags are stripped before sending.

A channel is only used when it is `enabled` **and** its token and destination id are non-empty. Failures are swallowed (`Promise.allSettled`). `testNotify()` sends a test message to verify configuration. The config lives in the `notify` setting; both channels default to disabled.

---

## 6. API-key storage & encryption at rest

Secrets are stored via the `store.ts` settings table in a local SQLite database (`data/trading.db`), with an `encrypted` flag per row. Exchange keys are written encrypted and are **never sent back to the browser** — they are read server-side only, inside `buildAdapter()`.

**Key derivation.** On first run, `loadOrCreateSecret()` generates 32 random bytes, writes them to `data/.secret` with `0o600` permissions, and derives a 32-byte key with `scrypt`. Subsequent runs re-derive the same key from that file.

**Cipher.** `encrypt()` uses **AES-256-GCM**: a fresh random 12-byte IV per value, the derived key, and the GCM auth tag. The stored value is `base64(iv).base64(tag).base64(ciphertext)`. `decrypt()` reverses this and verifies the auth tag, so tampered ciphertext fails to decrypt.

```text
data/.secret          → 32 random bytes, mode 0600, scrypt → 256-bit key
settings.value        → "<iv>.<tag>.<ciphertext>"  (AES-256-GCM, per-row IV)
```

> **Security summary:** Paper mode is the default and needs no credentials. Live trading requires *your own* exchange API keys. Those keys are encrypted at rest with a per-install key and are only ever decrypted on the server to sign requests — they are never returned to the frontend.

---

## 7. Worked examples

**Simple spot market buy (default `neworder`):**

```text
mktype=spot;symbol=XRPUSDT;side=buy;type=market;qty=20
```

**Open a futures long with attached stop and two take-profits, one command:**

```text
action=openposition;mktype=futures;symbol=ETHUSDT;side=BUY;openpro=25;lev=5;levforqty!;stop=3%;tp=[3200,50%][3400,50%]
```

**Resting conditional take-profit (reduce-only), fills on a future tick:**

```text
mktype=futures;symbol=BTCUSDT;side=sell;type=tp_market;closepro=100;trgpricepro=5;reduceonly!
```

**Distributed (spread) entry — one market slice + three limits across 1.5 %:**

```text
action=spreadentry;mktype=futures;symbol=ETHUSDT;side=BUY;qty=50;price=3000;spreadperc=1.5;spreadcount=3;stop=2%;tp=[3150,100%]
```

**Update protection on an open position without closing it:**

```text
action=chporders;mktype=futures;symbol=ADAUSDT;stop=0.48;tp=[0.55,50%][0.60,50%]
```

**Manual reversal with a chained pause (close → wait 500 ms → open opposite):**

```text
mktype=futures;symbol=ETHUSDT;side=buy;type=market;closepro=100;reduceonly!::pause=500;mktype=futures;symbol=ETHUSDT;side=sell;type=market;openpro=100;lev=2
```

**Read balance on spot, then price on futures, in one message set:**

```text
mktype=spot;get=BALANCE::mktype=futures;get=PRICE;symbol=BTCUSDT
```

**Set leverage, then cancel every resting order on a symbol:**

```text
set=LEVERAGE;symbol=BTCUSDT;lev=10;mktype=futures::action=cancelall;symbol=BTCUSDT;mktype=futures
```

---

## See also

- [Project README](../README.md)
- [Architecture](./ARCHITECTURE.md)
- [HTTP & WebSocket API](./API.md)
- [Strategies](./STRATEGIES.md)
- [Configuration](./CONFIGURATION.md)
