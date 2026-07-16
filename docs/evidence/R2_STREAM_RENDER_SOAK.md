# R2 stream/render soak evidence

Status: `automated pass; manual gates pending`

The authoritative threshold-enforced desktop/mobile browser run passed on
2026-07-16. This closes the automated R2.3 stream/render gate only. Android
Opera and assistive-technology results remain pending until they are executed
on the named real environments, so R2 and R2.3 remain `active`.

## Scope and non-claims

The synthetic harness validates the browser-side Monitoring lifecycle:

- high-frequency candle, compare, position and visible-watchlist work belongs to
  `ChartWorkspaceRuntime`, which is unmounted outside Monitoring;
- panes hidden by maximize and closed markets panels release their resources;
- the shell-level alert feed subscribes only to distinct untriggered/armed alert
  symbols and opens no quote socket for an empty armed set;
- the no-alert soak fixture releases both chart and watchlist quote
  subscriptions in Strategy Studio and recovers them exactly once on return;
- same-timestamp forming-candle updates use an O(1) provisional tail over
  immutable structural history; retained history copies occur only for
  snapshots, new timestamps and explicit history prepend.

This evidence does not prove exchange availability, server capacity for 100
users, paper profitability, live execution, HTTPS readiness or mainnet
readiness. It uses synthetic same-origin candles and opens no external market
connection.

## Run identity

| Field | Recorded value |
| --- | --- |
| Result | `2/2 passed`, no retry, `11.7 min` total |
| UTC date/time | `2026-07-16 13:59:46–14:05:20 UTC` |
| Operator | automated local release gate via `npm run test:soak:container` |
| Git commit | base commit `af8b1030273a28ce9982bf6e95eec5ccea02b705` |
| Release/build identifier | frontend generation `6441757a8687` |
| Working tree clean | no; the R2.3 candidate was under review, so the artifact hashes below bind the exact retained outputs |
| Host OS/kernel | Linux `6.8.0-87-generic`, x86_64 |
| Host CPU/RAM | Intel Xeon Platinum 8558, 192 logical CPUs, 2.0 TiB RAM |
| Docker version | client/server `28.5.1` |
| Playwright image | `mcr.microsoft.com/playwright:v1.61.1-noble` |
| Chromium version from artifact | `149.0.7827.55` |

## Commands

Optional short wiring check:

```bash
npm run test:soak:quick:container
```

The quick run uses a 15-second profile and is not acceptance evidence.

Authoritative threshold-enforced run:

```bash
npm run test:soak:container
```

The full command runs desktop and mobile serially with strict thresholds and
required instrumentation. Record the unmodified command output and both
Playwright JSON attachments. If a non-default duration or tick interval is used,
record the exact environment and reason; `acceptanceDuration` must remain true.

## Harness configuration

| Field | Desktop | Mobile |
| --- | ---: | ---: |
| Viewport | `1440x900` | `390x844` |
| Device scale factor | `1` | `3` |
| Touch/mobile emulation | no | yes |
| Retained history | `12,000` candles | `12,000` candles |
| Tick interval | `100 ms` default | `100 ms` default |
| Duration | `300,000 ms` default | `300,000 ms` default |
| Warm-up | `30,000 ms` default | `30,000 ms` default |
| Sample interval | `15,000 ms` default | `15,000 ms` default |
| Service workers | blocked | blocked |
| External HTTP requests | forbidden | forbidden |

Each profile measures active Monitoring, a Strategy Studio hidden phase and a
resumed Monitoring phase. The hidden phase is 20% of the configured duration.

## Acceptance thresholds

Do not replace a missing value with zero. Copy the values from each attached
summary.

| Check | Required gate | Desktop observed | Mobile observed |
| --- | --- | --- | --- |
| `acceptanceDuration` | `true` | `true` | `true` |
| Synthetic delivery | emitted candles `>= 75%` of expected | `2,402 >= 1,800` | `2,402 >= 1,800` |
| Active chart stream | active/max active exactly `1/1` | `1/1` | `1/1` |
| Visible watchlist quotes | desktop `1/1`; mobile `0/0` | `1/1` | `0/0` |
| Hidden subscriptions | chart `0`, watchlist quotes `0` | `0 / 0` | `0 / 0` |
| Exact recovery | one close/recreate, no duplicate active socket | pass; final stream `active/maxActive 1/1` | pass; final stream `active/maxActive 1/1` |
| Retained checkpoint stability | after bounded GC warm-up, each three-reading post-GC spread `<= max(1 MiB, 5% median)` | baseline/final `2,688 / 32 B` | baseline/final `2,320 / 32 B` |
| Retained JS heap upper growth | `<= max(8 MiB, 10% recovered baseline)` | `-3,055,496 B <= 8,388,608 B` | `-1,046,944 B <= 8,388,608 B` |
| Retained JS heap upper rate | `<= 1 MiB/min` | `-0.9712 MiB/min` | `-0.3328 MiB/min` |
| Maximum long task | `<= 150 ms` | `50 ms` | `114 ms` |
| Total blocking time | `<= 250 ms` | `0 ms` | `204 ms` |
| Event-loop maximum delay | `<= 250 ms` | `14 ms` | `42.6 ms` |
| Main-thread task duty | `<= 0.35` | `0.16577` | n/a; see mobile |
| Mobile main-thread task duty | `<= 0.45` | n/a | `0.21037` |
| Documents delta | `<= 0` | `0` | `0` |
| DOM nodes delta | `<= 50` | `0` | `-1` |
| Event listeners delta | `<= 10` | `0` | `0` |
| Copied candle elements/message | `<= 64` | `34.9854` | `35.0146` |
| Copy reason accounting | unclassified copied elements `0` | `0` | `0` |
| `App` renders/message | `<= 0.01` | `0` | `0` |
| Browser probes | render and stream probes present | present | present |
| Runtime integrity | no page/console errors or external HTTP requests | pass | pass |

Artifact schema v2 compares equivalent paused, frame-settled, post-GC
three-reading checkpoints after bounded GC warm-up. The conservative memory values use
`max(final) - min(baseline)`; median net growth is also recorded. Raw V8
`usedSize` samples and `rawJsHeapOlsSlopeMiBPerMinute` remain diagnostic only,
because ordinary generational-GC samples form a sawtooth. These fields measure
the JavaScript heap, not total Chromium renderer/process memory.

The retained diagnostic OLS slopes were `0.7071 MiB/min` on desktop and
`0.1588 MiB/min` on mobile. They are reported for transparency and were not
used in place of the stable post-GC checkpoint gates above.

The mobile quote expectation is zero because the mobile markets sheet is closed
in this fixture. The desktop expectation is one because the desktop markets
panel is visible. A separately armed price alert may intentionally keep its
minimal alert-only quote feed outside Monitoring; this no-alert fixture does
not exercise that exception.

## Attached artifacts

| Artifact | SHA-256 or retained path |
| --- | --- |
| Desktop `audits/soak/desktop-latest.json` | `b7b19f0e9aca81629f79b6ad60ced9d4a624119a85dd5797107ab1e6dbbab18d` |
| Mobile `audits/soak/mobile-latest.json` | `546555e0e963abd06940e841cd7d578f71f8b8506cf68aa9e4535326ac19d532` |
| Full stdout/stderr transcript `audits/soak/full-run.log` | `66e0b03210f387796491c15b8be6f412dacf704996900df4d518678246a341d6` |
| Failure trace/screenshot, when applicable | not applicable; both profiles passed |

## Automated review

- [x] Both profiles completed without retry.
- [x] Both summaries report `strictThresholds: true`.
- [x] Both summaries report `requireInstrumentation: true`.
- [x] Both summaries report `acceptanceDuration: true`.
- [x] Every `checks` field is true.
- [x] Subscription counts match the no-alert desktop/mobile fixture.
- [x] Heap/DOM/task samples show no unexplained monotonic growth.
- [x] Artifacts contain no credential, token, personal data or external market
      payload.

## Manual Android Opera gate

Status: `pending`

| Field | Recorded value |
| --- | --- |
| Device/model | `pending` |
| Android version | `pending` |
| Opera version/build | `pending` |
| Viewport/orientation | `pending` |
| Monitoring, panels and chart controls operable | `pending` |
| Drawing sheet, pinch/pan/long press operable | `pending` |
| Strategy Studio full width and dismissible | `pending` |
| Price axis unobscured; no horizontal document overflow | `pending` |
| Screenshot/video/evidence path | `pending` |

## Manual assistive-technology gates

Status: `pending`

| Environment | Version/device | Required journey | Result/evidence |
| --- | --- | --- | --- |
| VoiceOver + Safari | `pending` | navigation, markets dialog, chart alternative, drawing controls, Strategy Studio | `pending` |
| NVDA + Firefox/Chromium | `pending` | keyboard landmarks, dialogs, menus, chart table alternative, status announcements | `pending` |
| TalkBack + Android Chromium/Opera | `pending` | primary navigation, markets/instrument sheets, chart controls, close/focus restoration | `pending` |

## Final review

| Field | Recorded value |
| --- | --- |
| Automated soak | `passed 2026-07-16`; desktop/mobile `2/2`, no retry |
| Android Opera | `pending` |
| VoiceOver | `pending` |
| NVDA | `pending` |
| TalkBack | `pending` |
| Reviewer | automated threshold review complete; manual reviewer pending |
| R2.3 decision | `active`; automated gate passed, manual device/AT gates pending |

The automated portion of R2.3 is accepted. R2.3 may move to `done` only after
every manual gate above has a retained result. HTTPS, live execution, external
exchange readiness and the separate 100-user capacity proof remain explicitly
outside this evidence.
