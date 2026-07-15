import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { apiErrorHandler } from "../src/http/apiErrorHandler.js";

describe("API request body errors", () => {
  it.each([
    [{ status: 413, type: "entity.too.large" }, 413, "payload_too_large"],
    [{ status: 400, type: "entity.parse.failed" }, 400, "invalid_json"]
  ] as const)("returns a bounded client error for %o", (error, status, code) => {
    const response = responseDouble();
    apiErrorHandler(error, { method: "POST", path: "/api/jobs", headers: {} } as Request, response.value, vi.fn());
    expect(response.status).toHaveBeenCalledWith(status);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code }));
  });
});

function responseDouble() {
  const status = vi.fn();
  const json = vi.fn();
  const value = { headersSent: false, status, json } as unknown as Response;
  status.mockReturnValue(value);
  json.mockReturnValue(value);
  return { value, status, json };
}
