# Frontend market domain

Pure market-view models live here:

- `alerts.ts`: local price-alert lifecycle;
- `favorites.ts` and `watchlistPrefs.ts`: validated watchlist preferences;
- `dataQuality.ts`: deterministic missing-bar analysis shown in the feed panel;
- `virtualList.ts`: bounded fixed-row windowing for large watchlists while small
  lists remain fully present in the accessibility tree.

Quote transport is owned by `hooks/useSparklines.ts`. The browser uses one
`/quotes` WebSocket for the whole watchlist and falls back to the batched REST
endpoint after disconnects. Both payloads are runtime-validated by
`@saltanatbotv2/contracts`.
