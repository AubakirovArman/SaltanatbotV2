import type { RequestHandler } from "express";
import { networkIdentityService, type NetworkIdentityService } from "./service.js";

type ReadonlyNetworkIdentityService = Pick<NetworkIdentityService, "snapshot" | "evaluatePublic">;

export function createNetworkIdentityRegistryHandler(service: ReadonlyNetworkIdentityService = networkIdentityService, now: () => number = Date.now): RequestHandler {
  return (request, response) => {
    if (Object.keys(request.query).length > 0) {
      response.status(400).json({ error: "network identity registry does not accept query parameters" });
      return;
    }
    const snapshot = service.snapshot(now());
    const maxAgeSeconds = Math.min(300, Math.floor(snapshot.validity.remainingMs / 1_000));
    response.setHeader("Cache-Control", snapshot.validity.status === "current" ? `public, max-age=${maxAgeSeconds}` : "public, max-age=0, must-revalidate");
    response.json(snapshot);
  };
}

export function createNetworkIdentityPreflightHandler(service: ReadonlyNetworkIdentityService = networkIdentityService, now: () => number = Date.now): RequestHandler {
  return (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const evaluation = service.evaluatePublic(request.body, now());
    response.status(evaluation.validRequest ? 200 : 400).json(evaluation.result);
  };
}
