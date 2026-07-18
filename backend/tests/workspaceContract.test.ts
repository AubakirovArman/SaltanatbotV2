import { describe, expect, it } from "vitest";
import {
  advanceWorkspaceV8Content,
  assertWorkspaceInputSize,
  createWorkspaceExport,
  MAX_WORKSPACE_JSON_DEPTH,
  MAX_WORKSPACE_JSON_NODES,
  parseWorkspaceImport,
  workspacePayloadBytes,
  workspaceInputSchema
} from "../src/workspaces/documentContract.js";
import {
  DEFAULT_WORKSPACE_QUOTA_LIMITS,
  loadWorkspaceQuotaLimits,
  workspaceEnvelopeByteLimit
} from "../src/workspaces/quotas.js";
import {
  MAX_CONFIGURED_WORKSPACE_DOCUMENT_BYTES,
  WORKSPACE_DATABASE_PAYLOAD_BYTE_LIMIT,
  inspectWorkspaceJson,
  minimumWorkspaceRetainedPayloadBytes
} from "../src/workspaces/workspaceLimits.js";

describe("workspace v8 document contract", () => {
  it("advances server-created v8 lineage from the current content revision only", () => {
    const target = workspacePayload(3);
    const current = workspacePayload(17);
    const advanced = advanceWorkspaceV8Content(
      target,
      current,
      1_800_000_000_000
    );

    expect(advanced).toMatchObject({
      revision: 18,
      savedAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000
    });
    expect(
      advanceWorkspaceV8Content(
        { schemaVersion: 7, revision: 3, savedAt: 1, updatedAt: 1 },
        { schemaVersion: 7, revision: 17 },
        1_800_000_000_000
      )
    ).toEqual({ schemaVersion: 7, revision: 3, savedAt: 1, updatedAt: 1 });
  });

  it("accepts a bounded complete v8 workflow and keeps content revision independent", () => {
    const payload = workspacePayload(9);
    const parsed = workspaceInputSchema.parse({
      clientId: payload.id,
      name: payload.name,
      schemaVersion: 8,
      payload
    });

    expect(parsed.payload).toMatchObject({
      revision: 9,
      history: [],
      mode: "chart",
      drawings: [{ chartId: "chart-1", drawings: [] }]
    });
  });

  it("rejects unknown current-schema fields, mismatched identity, and future schemas", () => {
    expect(
      workspaceInputSchema.safeParse({
        clientId: "workspace-v8",
        name: "Workspace v8",
        schemaVersion: 8,
        payload: { ...workspacePayload(1), unexpected: true }
      }).success
    ).toBe(false);
    expect(
      workspaceInputSchema.safeParse({
        clientId: "other-id",
        name: "Workspace v8",
        schemaVersion: 8,
        payload: workspacePayload(1)
      }).success
    ).toBe(false);
    expect(
      workspaceInputSchema.safeParse({
        clientId: "future",
        name: "Future",
        schemaVersion: 10,
        payload: {}
      }).success
    ).toBe(false);
  });

  it("rejects unsafe content revisions and PostgreSQL-incompatible strings before persistence", () => {
    expect(
      workspaceInputSchema.safeParse({
        clientId: "unsafe-revision",
        name: "Unsafe revision",
        schemaVersion: 8,
        payload: {
          ...workspacePayload(1),
          id: "unsafe-revision",
          name: "Unsafe revision",
          revision: 1e100
        }
      }).success
    ).toBe(false);
    expect(
      workspaceInputSchema.safeParse({
        clientId: "nul-name",
        name: "NUL\u0000name",
        schemaVersion: 1,
        payload: {}
      }).success
    ).toBe(false);
    expect(
      workspaceInputSchema.safeParse({
        clientId: "nul-payload",
        name: "NUL payload",
        schemaVersion: 1,
        payload: { nested: { value: "NUL\u0000value" } }
      }).success
    ).toBe(false);
    expect(
      workspaceInputSchema.safeParse({
        clientId: "surrogate-payload",
        name: "Surrogate payload",
        schemaVersion: 1,
        payload: { value: "\ud800" }
      }).success
    ).toBe(false);
    expect(
      workspaceInputSchema.safeParse({
        clientId: "infinite-payload",
        name: "Infinite payload",
        schemaVersion: 1,
        payload: { value: Number.POSITIVE_INFINITY }
      }).success
    ).toBe(false);
  });

  it("bounds legacy JSON depth and node count before recursive serialization", () => {
    let tooDeep: Record<string, unknown> = {};
    for (let depth = 0; depth <= MAX_WORKSPACE_JSON_DEPTH; depth += 1) {
      tooDeep = { nested: tooDeep };
    }
    expect(
      workspaceInputSchema.safeParse({
        clientId: "too-deep",
        name: "Too deep",
        schemaVersion: 1,
        payload: tooDeep
      }).success
    ).toBe(false);

    expect(
      workspaceInputSchema.safeParse({
        clientId: "too-many-nodes",
        name: "Too many nodes",
        schemaVersion: 1,
        payload: { values: Array.from({ length: MAX_WORKSPACE_JSON_NODES }, () => 0) }
      }).success
    ).toBe(false);
  });

  it("round-trips the exact legacy-compatible checksum envelope and rejects tampering", () => {
    const payload = workspacePayload(3);
    const document = createWorkspaceExport({
      clientId: payload.id,
      name: payload.name,
      schemaVersion: 8,
      payload
    });

    expect(Object.keys(document).sort()).toEqual([
      "algorithm",
      "checksum",
      "exportedAt",
      "format",
      "version",
      "workspace"
    ]);
    expect(
      parseWorkspaceImport(
        { document, clientId: "imported-v8", name: "Imported v8" },
        DEFAULT_WORKSPACE_QUOTA_LIMITS
      )
    ).toMatchObject({
      clientId: "imported-v8",
      name: "Imported v8",
      schemaVersion: 8,
      payload: { id: "imported-v8", name: "Imported v8", revision: 3 }
    });
    expect(() =>
      parseWorkspaceImport(
        {
          ...document,
          workspace: { ...document.workspace, symbol: "ETHUSDT" }
        },
        DEFAULT_WORKSPACE_QUOTA_LIMITS
      )
    ).toThrow(/checksum/i);
  });

  it("round-trips its own compact export when the payload is exactly at the document limit", () => {
    const limits = {
      ...DEFAULT_WORKSPACE_QUOTA_LIMITS,
      maxDocumentBytes: 4_096,
      maxRetainedPayloadBytesPerOwner: 65_536
    };
    const payload = workspacePayload(3);
    payload.enabledIndicators = ["near-limit"];
    payload.indicators = [
      {
        id: "near-limit",
        label: "Near limit",
        enabled: true,
        kind: "sma",
        period: 20,
        color: "#fff",
        logicCode: "x"
      }
    ];
    const remaining = limits.maxDocumentBytes - workspacePayloadBytes(payload);
    expect(remaining).toBeGreaterThan(0);
    (
      payload.indicators as Array<Record<string, unknown>>
    )[0]!.logicCode = "x".repeat(remaining + 1);
    expect(workspacePayloadBytes(payload)).toBe(limits.maxDocumentBytes);

    const document = createWorkspaceExport({
      clientId: payload.id,
      name: payload.name,
      schemaVersion: 8,
      payload
    });
    const envelopeBytes = Buffer.byteLength(JSON.stringify(document), "utf8");
    expect(envelopeBytes).toBeGreaterThan(limits.maxDocumentBytes);
    expect(envelopeBytes).toBeLessThanOrEqual(workspaceEnvelopeByteLimit(limits));
    expect(parseWorkspaceImport(document, limits)).toMatchObject({
      clientId: payload.id,
      schemaVersion: 8,
      payload: { id: payload.id, indicators: [{ id: "near-limit" }] }
    });
  });

  it("accepts a bounded exponent payload and rejects one whose jsonb form would exceed the response reserve", () => {
    const acceptedPayload = {
      values: Array.from({ length: 12_000 }, () => 5e-324)
    };
    const rejectedPayload = {
      values: Array.from({ length: 13_000 }, () => 5e-324)
    };
    const accepted = {
      clientId: "exponent-accepted",
      name: "Exponent accepted",
      schemaVersion: 1,
      payload: acceptedPayload
    };
    const rejected = {
      clientId: "exponent-rejected",
      name: "Exponent rejected",
      schemaVersion: 1,
      payload: rejectedPayload
    };
    expect(inspectWorkspaceJson(acceptedPayload).databaseBytesUpperBound).toBeLessThanOrEqual(
      WORKSPACE_DATABASE_PAYLOAD_BYTE_LIMIT
    );
    expect(inspectWorkspaceJson(rejectedPayload).databaseBytesUpperBound).toBeGreaterThan(
      WORKSPACE_DATABASE_PAYLOAD_BYTE_LIMIT
    );
    expect(() =>
      assertWorkspaceInputSize(workspaceInputSchema.parse(accepted), DEFAULT_WORKSPACE_QUOTA_LIMITS)
    ).not.toThrow();
    try {
      assertWorkspaceInputSize(
        workspaceInputSchema.parse(rejected),
        DEFAULT_WORKSPACE_QUOTA_LIMITS
      );
      throw new Error("Expected the database representation bound to reject");
    } catch (error) {
      expect(error).toMatchObject({
        code: "workspace_database_document_too_large",
        status: 413,
        attempted: { databaseDocumentBytes: expect.any(Number) }
      });
    }
  });

  it("accepts a valid checksum-protected v7 file while rejecting unversioned legacy imports", () => {
    const payload = workspaceV7Payload();
    const document = createWorkspaceExport({
      clientId: payload.id,
      name: payload.name,
      schemaVersion: 7,
      payload
    });

    expect(
      parseWorkspaceImport(document, DEFAULT_WORKSPACE_QUOTA_LIMITS)
    ).toMatchObject({
      clientId: payload.id,
      name: payload.name,
      schemaVersion: 7,
      payload: { schemaVersion: 7, revision: 5 }
    });
    expect(() =>
      parseWorkspaceImport(
        createWorkspaceExport({
          clientId: "legacy-v6",
          name: "Legacy v6",
          schemaVersion: 6,
          payload: {
            schemaVersion: 6,
            id: "legacy-v6",
            name: "Legacy v6"
          }
        }),
        DEFAULT_WORKSPACE_QUOTA_LIMITS
      )
    ).toThrow(/invalid/i);
  });
});

describe("workspace v9 document contract", () => {
  it("accepts both research tools with note metadata and advances v9 lineage", () => {
    const payload = workspaceV9Payload(4);
    const parsed = workspaceInputSchema.safeParse({
      clientId: payload.id,
      name: payload.name,
      schemaVersion: 9,
      payload
    });
    expect(parsed.success).toBe(true);

    expect(
      advanceWorkspaceV8Content(payload, workspaceV9Payload(11), 1_800_000_000_000)
    ).toMatchObject({
      schemaVersion: 9,
      revision: 12,
      savedAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000
    });
  });

  it("keeps the unchanged v8 payload valid while rejecting v8 documents carrying v9 tools", () => {
    const v8Payload = workspacePayload(1);
    expect(
      workspaceInputSchema.safeParse({
        clientId: v8Payload.id,
        name: v8Payload.name,
        schemaVersion: 8,
        payload: v8Payload
      }).success
    ).toBe(true);

    const v8WithNote = workspacePayload(1);
    v8WithNote.drawings = [
      {
        chartId: "chart-1",
        symbol: "BTCUSDT",
        drawings: [textNoteDrawing()]
      }
    ];
    expect(
      workspaceInputSchema.safeParse({
        clientId: v8WithNote.id,
        name: v8WithNote.name,
        schemaVersion: 8,
        payload: v8WithNote
      }).success
    ).toBe(false);
  });

  it("rejects note metadata on non-note tools and malformed note fields", () => {
    const trendWithText = {
      id: "trend-1",
      tool: "trendline",
      points: [
        { time: 1_752_640_000_000, price: 60_000 },
        { time: 1_752_650_000_000, price: 61_000 }
      ],
      style: { color: "#4db6ff", width: 1.5 },
      text: "not allowed here"
    };
    expect(v9WithDrawings([trendWithText]).success).toBe(false);
    expect(
      v9WithDrawings([{ ...channelDrawing(), text: "not allowed here" }]).success
    ).toBe(false);
    expect(
      v9WithDrawings([{ ...textNoteDrawing(), text: "tab\tcharacter" }]).success
    ).toBe(false);
    expect(v9WithDrawings([{ ...textNoteDrawing(), text: "" }]).success).toBe(false);
    expect(
      v9WithDrawings([{ ...textNoteDrawing(), text: "x".repeat(501) }]).success
    ).toBe(false);
    expect(
      v9WithDrawings([{ ...textNoteDrawing(), author: "two\nlines" }]).success
    ).toBe(false);
    expect(
      v9WithDrawings([{ ...textNoteDrawing(), createdAt: 0.5 }]).success
    ).toBe(false);
    expect(
      v9WithDrawings([{ ...textNoteDrawing(), points: [
        { time: 1_752_640_000_000, price: 60_000 },
        { time: 1_752_650_000_000, price: 61_000 }
      ] }]).success
    ).toBe(false);
    expect(
      v9WithDrawings([{ ...textNoteDrawing(), text: "Multi\nline note" }]).success
    ).toBe(true);
  });

  it("enforces the canonical channel geometry contract on parallel channels", () => {
    const zeroWidth = channelDrawing();
    zeroWidth.points = [
      { time: 1_752_640_000_000, price: 60_000 },
      { time: 1_752_650_000_000, price: 61_000 },
      { time: 1_752_645_000_000, price: 60_500 }
    ];
    expect(v9WithDrawings([zeroWidth]).success).toBe(false);

    const sharedTime = channelDrawing();
    sharedTime.points = [
      { time: 1_752_640_000_000, price: 60_000 },
      { time: 1_752_640_000_000, price: 61_000 },
      { time: 1_752_645_000_000, price: 59_500 }
    ];
    expect(v9WithDrawings([sharedTime]).success).toBe(false);

    const preEpoch = channelDrawing();
    preEpoch.points = [
      { time: -1_000, price: 60_000 },
      { time: 1_752_650_000_000, price: 61_000 },
      { time: 1_752_645_000_000, price: 59_500 }
    ];
    expect(v9WithDrawings([preEpoch]).success).toBe(false);

    expect(v9WithDrawings([channelDrawing()]).success).toBe(true);
  });

  it("imports its own v9 export envelope while the gate still rejects future schemas", () => {
    const payload = workspaceV9Payload(3);
    const document = createWorkspaceExport({
      clientId: payload.id,
      name: payload.name,
      schemaVersion: 9,
      payload
    });

    expect(
      parseWorkspaceImport(
        { document, clientId: "imported-v9", name: "Imported v9" },
        DEFAULT_WORKSPACE_QUOTA_LIMITS
      )
    ).toMatchObject({
      clientId: "imported-v9",
      name: "Imported v9",
      schemaVersion: 9,
      payload: { id: "imported-v9", name: "Imported v9", revision: 3 }
    });

    const future = workspaceV9Payload(3);
    future.schemaVersion = 10;
    expect(() =>
      parseWorkspaceImport(
        createWorkspaceExport({
          clientId: future.id,
          name: future.name,
          schemaVersion: 9,
          payload: future
        }),
        DEFAULT_WORKSPACE_QUOTA_LIMITS
      )
    ).toThrow(/import document is invalid/);
  });
});

describe("workspace quota configuration", () => {
  it("proves a conservative jsonb::text bound for spacing and exponent expansion", () => {
    const compact = '{"a":1,"b":2}';
    const postgres = '{"a": 1, "b": 2}';
    const inspectedSpacing = inspectWorkspaceJson({ a: 1, b: 2 });
    expect(Buffer.byteLength(postgres, "utf8")).toBe(
      Buffer.byteLength(compact, "utf8") + 3
    );
    expect(Buffer.byteLength(postgres, "utf8")).toBeLessThanOrEqual(
      inspectedSpacing.databaseBytesUpperBound
    );

    const compactExponent = JSON.stringify({ tiny: 5e-324 });
    const postgresExponent = `{"tiny": 0.${"0".repeat(323)}5}`;
    const inspectedExponent = inspectWorkspaceJson({ tiny: 5e-324 });
    expect(Buffer.byteLength(postgresExponent, "utf8")).toBeGreaterThan(
      Buffer.byteLength(compactExponent, "utf8")
    );
    expect(Buffer.byteLength(postgresExponent, "utf8")).toBeLessThanOrEqual(
      inspectedExponent.databaseBytesUpperBound
    );
    expect(DEFAULT_WORKSPACE_QUOTA_LIMITS.maxRetainedPayloadBytesPerOwner).toBeGreaterThanOrEqual(
      minimumWorkspaceRetainedPayloadBytes()
    );
  });

  it("keeps the full four-chart drawing contract above 8k JSON nodes", () => {
    const payload = workspacePayload(9);
    payload.layout = {
      ...(payload.layout as Record<string, unknown>),
      preset: "grid-4"
    };
    payload.charts = Array.from({ length: 4 }, (_, index) => ({
      ...(payload.charts as Array<Record<string, unknown>>)[0],
      id: `chart-${index + 1}`
    }));
    payload.drawings = Array.from({ length: 4 }, (_, scope) => ({
      chartId: `chart-${scope + 1}`,
      symbol: "BTCUSDT",
      drawings: Array.from({ length: 500 }, (_, index) => ({
        id: `drawing-${scope}-${index}`,
        tool: "hline",
        points: [{ time: index + 1, price: 60_000 + index }],
        style: { color: "#ffffff", width: 1 }
      }))
    }));

    const inspection = inspectWorkspaceJson(payload);
    expect(inspection.nodes).toBeGreaterThan(8_192);
    expect(inspection.compactBytes).toBeLessThanOrEqual(
      DEFAULT_WORKSPACE_QUOTA_LIMITS.maxDocumentBytes
    );
    expect(inspection.databaseBytesUpperBound).toBeLessThanOrEqual(
      WORKSPACE_DATABASE_PAYLOAD_BYTE_LIMIT
    );
    expect(
      workspaceInputSchema.safeParse({
        clientId: payload.id,
        name: payload.name,
        schemaVersion: 8,
        payload
      }).success
    ).toBe(true);
  });

  it("uses the documented conservative defaults and accepts bounded overrides", () => {
    expect(loadWorkspaceQuotaLimits({})).toEqual(
      DEFAULT_WORKSPACE_QUOTA_LIMITS
    );
    expect(
      loadWorkspaceQuotaLimits({
        WORKSPACE_MAX_ACTIVE_PER_USER: "10",
        WORKSPACE_MAX_TOTAL_PER_USER: "30",
        WORKSPACE_MAX_REVISIONS_PER_WORKSPACE: "12",
        WORKSPACE_MAX_DOCUMENT_BYTES: "524288",
        WORKSPACE_MAX_RETAINED_PAYLOAD_BYTES_PER_USER: "8388608"
      })
    ).toEqual({
      maxActiveWorkspaces: 10,
      maxTotalWorkspaces: 30,
      maxRevisionsPerWorkspace: 12,
      maxDocumentBytes: 524_288,
      maxRetainedPayloadBytesPerOwner: 8_388_608
    });
  });

  it("fails closed on contradictory or unsafe quota configuration", () => {
    expect(() =>
      loadWorkspaceQuotaLimits({
        WORKSPACE_MAX_ACTIVE_PER_USER: "26",
        WORKSPACE_MAX_TOTAL_PER_USER: "25"
      })
    ).toThrow(/cannot exceed/i);
    expect(() =>
      loadWorkspaceQuotaLimits({
        WORKSPACE_MAX_DOCUMENT_BYTES: "1048576",
        WORKSPACE_MAX_RETAINED_PAYLOAD_BYTES_PER_USER: "2097152"
      })
    ).toThrow(/current document and its first revision/i);
    expect(() =>
      loadWorkspaceQuotaLimits({
        WORKSPACE_MAX_DOCUMENT_BYTES: String(
          MAX_CONFIGURED_WORKSPACE_DOCUMENT_BYTES + 1
        )
      })
    ).toThrow(/must be an integer/i);
    expect(() =>
      loadWorkspaceQuotaLimits({
        WORKSPACE_MAX_TOTAL_PER_USER: "3201"
      })
    ).toThrow(/must be an integer/i);
    expect(() =>
      loadWorkspaceQuotaLimits({
        WORKSPACE_MAX_RETAINED_PAYLOAD_BYTES_PER_USER: "67108865"
      })
    ).toThrow(/must be an integer/i);
    expect(
      loadWorkspaceQuotaLimits({
        WORKSPACE_MAX_RETAINED_PAYLOAD_BYTES_PER_USER: String(
          minimumWorkspaceRetainedPayloadBytes()
        )
      }).maxRetainedPayloadBytesPerOwner
    ).toBe(minimumWorkspaceRetainedPayloadBytes());
    expect(() =>
      loadWorkspaceQuotaLimits({
        WORKSPACE_MAX_RETAINED_PAYLOAD_BYTES_PER_USER: String(
          minimumWorkspaceRetainedPayloadBytes() - 1
        )
      })
    ).toThrow(/current document and its first revision/i);
  });
});

function workspacePayload(revision: number): Record<string, unknown> & {
  id: string;
  name: string;
} {
  return {
    schemaVersion: 8,
    id: "workspace-v8",
    name: "Workspace v8",
    createdAt: 1_752_640_000_000,
    updatedAt: 1_752_640_000_000 + revision,
    history: [],
    revision,
    savedAt: 1_752_640_000_000 + revision,
    mode: "chart",
    symbol: "BTCUSDT",
    timeframe: "1m",
    chartType: "candles",
    cryptoExchange: "binance",
    enabledIndicators: [],
    indicators: [],
    compareOverlays: [],
    theme: "dark",
    layout: {
      preset: "single",
      leftOpen: true,
      rightOpen: true,
      leftSize: 260,
      rightSize: 280,
      panelsSwapped: false
    },
    charts: [
      {
        id: "chart-1",
        symbol: "BTCUSDT",
        timeframe: "1m",
        chartType: "candles",
        timeZone: "exchange",
        linkChartType: true,
        linkGroup: "primary",
        linkSymbol: true,
        linkTimeframe: true,
        linkCrosshair: true,
        linkTimeRange: true,
        linkIndicators: true,
        linkCompare: true
      }
    ],
    activeChartId: "chart-1",
    drawings: [{ chartId: "chart-1", symbol: "BTCUSDT", drawings: [] }]
  };
}

function workspaceV9Payload(revision: number): Record<string, unknown> & {
  id: string;
  name: string;
} {
  return {
    ...workspacePayload(revision),
    schemaVersion: 9,
    id: "workspace-v9",
    name: "Workspace v9",
    drawings: [
      {
        chartId: "chart-1",
        symbol: "BTCUSDT",
        drawings: [textNoteDrawing(), channelDrawing()]
      }
    ]
  };
}

function textNoteDrawing(): Record<string, unknown> {
  return {
    id: "note-1",
    tool: "text-note",
    points: [{ time: 1_752_640_000_000, price: 60_000 }],
    style: { color: "#f7c948", width: 1.5 },
    text: "Support retest\nwatch the volume",
    author: "owner-login",
    createdAt: 1_752_640_000_000
  };
}

function channelDrawing(): Record<string, unknown> & { points: unknown } {
  return {
    id: "channel-1",
    tool: "parallel-channel",
    points: [
      { time: 1_752_640_000_000, price: 60_000 },
      { time: 1_752_650_000_000, price: 61_000 },
      { time: 1_752_645_000_000, price: 59_500 }
    ],
    style: { color: "#4db6ff", width: 1.5 }
  };
}

function v9WithDrawings(drawings: Array<Record<string, unknown>>) {
  const payload = workspaceV9Payload(1);
  payload.drawings = [{ chartId: "chart-1", symbol: "BTCUSDT", drawings }];
  return workspaceInputSchema.safeParse({
    clientId: payload.id,
    name: payload.name,
    schemaVersion: 9,
    payload
  });
}

function workspaceV7Payload(): Record<string, unknown> & {
  id: string;
  name: string;
} {
  const chart = {
    id: "chart-1",
    symbol: "BTCUSDT",
    timeframe: "1m",
    chartType: "candles",
    timeZone: "exchange",
    linkChartType: true,
    linkGroup: "primary",
    linkSymbol: true,
    linkTimeframe: true,
    linkCrosshair: true,
    linkTimeRange: true,
    linkIndicators: true,
    linkCompare: true
  };
  const layout = {
    preset: "single",
    leftOpen: true,
    rightOpen: true,
    leftSize: 260,
    rightSize: 280,
    panelsSwapped: false
  };
  return {
    schemaVersion: 7,
    id: "workspace-v7",
    name: "Workspace v7",
    createdAt: 1_752_640_000_000,
    updatedAt: 1_752_640_000_005,
    history: [],
    revision: 5,
    savedAt: 1_752_640_000_005,
    symbol: "BTCUSDT",
    timeframe: "1m",
    chartType: "candles",
    cryptoExchange: "binance",
    enabledIndicators: [],
    compareOverlays: [],
    theme: "dark",
    layout,
    charts: [chart]
  };
}
