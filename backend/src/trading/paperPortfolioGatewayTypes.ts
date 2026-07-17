import type { PaperPortfolioExecutorPayload } from "./paperPortfolioCommandContract.js";

export interface PaperPortfolioCommandPrincipal {
  ownerUserId: string;
  actorUserId: string | null;
  sessionIdHash: string;
  authorizationRevision: number;
  authorizationEpoch: number;
}

export interface PaperPortfolioMutationGateway {
  execute(input: {
    principal: PaperPortfolioCommandPrincipal;
    idempotencyKey: string;
    requestHash: string;
    payload: PaperPortfolioExecutorPayload;
  }): Promise<{ replayed: boolean }>;
}

export class PaperPortfolioHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "PaperPortfolioHttpError";
  }
}
