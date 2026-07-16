import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceRepository } from "../src/workspaces/repository.js";
import {
  WORKSPACE_RESPONSE_BYTE_LIMIT,
  WorkspaceResponseItemTooLargeError,
  readWorkspaceListPage,
  readWorkspaceRevisionPage
} from "../src/workspaces/workspacePagination.js";
import type { WorkspaceRow } from "../src/workspaces/repositorySupport.js";
import { MAX_CONFIGURED_WORKSPACE_DOCUMENT_BYTES } from "../src/workspaces/workspaceLimits.js";

const OWNER = "00000000-0000-4000-8000-000000000031";
const IDS = Array.from(
  { length: 4 },
  (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
);
const LIMITS = {
  maxActiveWorkspaces: 25,
  maxTotalWorkspaces: 75,
  maxRevisionsPerWorkspace: 20,
  maxDocumentBytes: 1_048_576,
  maxRetainedPayloadBytesPerOwner: 67_108_864
};

describe("bounded workspace response pagination", () => {
  it("fetches metadata first, returns a byte-bounded UUID page, and snapshots quota with rows", async () => {
    const payload = { padding: "x".repeat(1_050_000) };
    const rows = IDS.slice(0, 3).map((id, index) =>
      workspaceRow(id, `client-${index + 1}`, 1, payload)
    );
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes("SELECT id, payload_bytes::text")) {
        return {
          rows: IDS.map((id) => ({
            id,
            payload_bytes: String(Buffer.byteLength(JSON.stringify(payload), "utf8"))
          }))
        };
      }
      if (text.includes("id = ANY")) {
        expect(values?.[1]).toEqual(IDS.slice(0, 3));
        return { rows };
      }
      if (text.includes("AS active_count")) {
        return {
          rows: [
            {
              active_count: "4",
              total_count: "4",
              payload_bytes_used: "4120060"
            }
          ]
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    const result = await readWorkspaceListPage(
      { query } as unknown as PoolClient,
      OWNER,
      "all",
      undefined,
      25,
      LIMITS
    );

    expect(result.workspaces.map((workspace) => workspace.id)).toEqual(
      IDS.slice(0, 3)
    );
    expect(result.page).toMatchObject({
      returnedItems: 3,
      hasMore: true,
      nextCursor: IDS[2],
      responseByteLimit: WORKSPACE_RESPONSE_BYTE_LIMIT
    });
    expect(result.page.responseBytes).toBe(
      Buffer.byteLength(JSON.stringify(result), "utf8")
    );
    expect(result.page.responseBytes).toBeLessThanOrEqual(
      WORKSPACE_RESPONSE_BYTE_LIMIT
    );
    expect(query.mock.calls.map(([text]) => String(text))).toEqual([
      expect.stringContaining("SELECT id, payload_bytes::text"),
      expect.stringContaining("id = ANY"),
      expect.stringContaining("AS active_count")
    ]);
  });

  it("uses descending revision keysets and exposes the next retained revision cursor", async () => {
    const revisions = Array.from({ length: 11 }, (_, index) => 12 - index);
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes("SELECT r.revision::text")) {
        expect(values?.[2]).toBeNull();
        return {
          rows: revisions.map((revision) => ({
            revision: String(revision),
            payload_bytes: "32"
          }))
        };
      }
      if (text.includes("r.revision = ANY")) {
        return {
          rows: revisions
            .slice(0, 10)
            .map((revision) =>
              workspaceRow(IDS[0]!, "revision-client", revision, {
                revision
              })
            )
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    const result = await readWorkspaceRevisionPage(
      { query } as unknown as PoolClient,
      OWNER,
      IDS[0]!,
      undefined,
      10
    );

    expect(result.revisions.map((revision) => revision.revision)).toEqual(
      revisions.slice(0, 10)
    );
    expect(result.page).toMatchObject({
      returnedItems: 10,
      hasMore: true,
      nextCursor: "3"
    });
    expect(result.page.responseBytes).toBeLessThanOrEqual(
      WORKSPACE_RESPONSE_BYTE_LIMIT
    );
  });

  it("fits one compact maximum-size document with the response wrapper", async () => {
    const empty = Buffer.byteLength(JSON.stringify({ padding: "" }), "utf8");
    const payload = {
      padding: "x".repeat(MAX_CONFIGURED_WORKSPACE_DOCUMENT_BYTES - empty)
    };
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBe(
      MAX_CONFIGURED_WORKSPACE_DOCUMENT_BYTES
    );
    const row = workspaceRow(IDS[0]!, "maximum-client", 1, payload);
    const query = vi.fn(async (text: string) => {
      if (text.includes("SELECT id, payload_bytes::text")) {
        return {
          rows: [{ id: IDS[0], payload_bytes: row.payload_bytes }]
        };
      }
      if (text.includes("id = ANY")) return { rows: [row] };
      if (text.includes("AS active_count")) {
        return {
          rows: [
            {
              active_count: "1",
              total_count: "1",
              payload_bytes_used: row.payload_bytes
            }
          ]
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    const result = await readWorkspaceListPage(
      { query } as unknown as PoolClient,
      OWNER,
      "all",
      undefined,
      25,
      LIMITS
    );

    expect(result.workspaces).toHaveLength(1);
    expect(result.page.responseBytes).toBeLessThanOrEqual(
      WORKSPACE_RESPONSE_BYTE_LIMIT
    );
  });

  it("rejects a persisted item above the page ceiling before fetching its payload", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("SELECT id, payload_bytes::text")) {
        return {
          rows: [
            {
              id: IDS[0],
              payload_bytes: String(WORKSPACE_RESPONSE_BYTE_LIMIT + 1)
            }
          ]
        };
      }
      throw new Error("Payload query must not run");
    });

    await expect(
      readWorkspaceListPage(
        { query } as unknown as PoolClient,
        OWNER,
        "all",
        undefined,
        25,
        LIMITS
      )
    ).rejects.toBeInstanceOf(WorkspaceResponseItemTooLargeError);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("reads list rows and quota through one read-only repeatable-read transaction", async () => {
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        calls.push(text);
        if (text.includes("SELECT id, payload_bytes::text")) return { rows: [] };
        if (text.includes("AS active_count")) {
          return {
            rows: [
              {
                active_count: "0",
                total_count: "0",
                payload_bytes_used: "0"
              }
            ]
          };
        }
        return { rows: [] };
      }),
      release: vi.fn()
    } as unknown as PoolClient;
    const pool = {
      connect: vi.fn(async () => client)
    } as unknown as Pool;

    const page = await new WorkspaceRepository(pool, LIMITS).listPage(
      OWNER,
      "all",
      undefined,
      25
    );

    expect(page).toMatchObject({
      workspaces: [],
      quota: { activeCount: 0, totalCount: 0 },
      page: { hasMore: false }
    });
    expect(calls[0]).toBe(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
    );
    expect(calls.at(-1)).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });
});

function workspaceRow(
  id: string,
  clientId: string,
  revision: number,
  payload: Record<string, unknown>
): WorkspaceRow {
  return {
    id,
    client_id: clientId,
    name: clientId,
    schema_version: 1,
    payload,
    payload_bytes: String(Buffer.byteLength(JSON.stringify(payload), "utf8")),
    revision: String(revision),
    archived_at: null,
    created_at: new Date("2026-07-16T00:00:00.000Z"),
    updated_at: new Date(`2026-07-16T00:00:${String(revision).padStart(2, "0")}.000Z`)
  };
}
