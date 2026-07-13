export const PWA_SHARE_TARGET = {
  action: "/share-target",
  field: "research_files",
  database: "saltanat-pwa-share-target",
  store: "shares",
  recordVersion: 1,
  messagePrefix: "saltanat:share-target:",
  maxFiles: 10,
  maxTotalBytes: 10_000_000,
  maxRequestBytes: 12_000_000,
  maxPendingBatches: 5,
  retentionMs: 24 * 60 * 60 * 1000,
  fileLimits: {
    pine: 1_000_000,
    strategy: 2_000_000,
    plugin: 5_000_000
  },
  extensions: [".pine", ".strategy", ".saltanat-plugin"],
  mimeTypes: [
    "application/vnd.saltanatbotv2.strategy+json",
    "application/vnd.saltanatbotv2.plugin+json"
  ]
} as const;

export const PWA_SHARE_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
