export const MAX_COMPUTE_JOB_RESULT_BYTES = 4 * 1024 * 1024;

export type ComputeJobResultRejectionCode = "result_not_serializable" | "result_too_large";

export class ComputeJobResultRejectedError extends Error {
  constructor(
    readonly code: ComputeJobResultRejectionCode,
    message: string
  ) {
    super(message);
    this.name = "ComputeJobResultRejectedError";
  }
}

/**
 * Produces the exact JSON string sent to PostgreSQL and enforces the limit on
 * UTF-8 bytes, not JavaScript code units. Error messages intentionally contain
 * no result content.
 */
export function serializeComputeJobResult(
  result: Record<string, unknown>,
  maximumBytes = MAX_COMPUTE_JOB_RESULT_BYTES
): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(result);
  } catch {
    throw new ComputeJobResultRejectedError(
      "result_not_serializable",
      "Research job result is not JSON-serializable."
    );
  }
  if (serialized === undefined) {
    throw new ComputeJobResultRejectedError(
      "result_not_serializable",
      "Research job result is not JSON-serializable."
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw new ComputeJobResultRejectedError(
      "result_too_large",
      `Research job result exceeds the ${maximumBytes}-byte limit.`
    );
  }
  return serialized;
}
