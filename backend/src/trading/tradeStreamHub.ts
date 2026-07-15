import { WebSocket } from "ws";
import type { TradeEvent } from "./engineEvents.js";

const DEFAULT_MAX_BUFFERED_BYTES = 512 * 1024;

interface ClientRegistration {
  socket: WebSocket;
  sessionIdHash?: string;
  expiryTimer?: NodeJS.Timeout;
}

export interface TradeStreamHubOptions {
  maxBufferedBytes?: number;
  now?: () => number;
}

/** Owner-partitioned private trading event fan-out.
 *
 * An event without an owner is dropped fail-closed. Internal ownership metadata
 * is removed before serialization, so it is never exposed as an API field.
 */
export class TradeStreamHub {
  private readonly clients = new Map<string, Set<ClientRegistration>>();
  private readonly maxBufferedBytes: number;
  private readonly now: () => number;

  constructor(options: TradeStreamHubOptions = {}) {
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.now = options.now ?? Date.now;
  }

  attach(socket: WebSocket, ownerUserId: string, expiresAt?: number, sessionIdHash?: string): void {
    if (!ownerUserId || (expiresAt !== undefined && expiresAt <= this.now())) {
      socket.close(1008, "Trading session expired");
      return;
    }

    const registration: ClientRegistration = { socket, sessionIdHash };
    const registrations = this.clients.get(ownerUserId) ?? new Set<ClientRegistration>();
    registrations.add(registration);
    this.clients.set(ownerUserId, registrations);

    const remove = () => this.remove(ownerUserId, registration);
    socket.once("close", remove);
    socket.once("error", remove);

    if (expiresAt !== undefined && Number.isFinite(expiresAt)) {
      const delay = Math.max(0, expiresAt - this.now());
      registration.expiryTimer = setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(1008, "Trading session expired");
        }
        remove();
      }, Math.min(delay, 2_147_483_647));
      registration.expiryTimer.unref?.();
    }
  }

  publish(event: TradeEvent): void {
    const ownerUserId = event.ownerUserId;
    if (!ownerUserId) return;
    const registrations = this.clients.get(ownerUserId);
    if (!registrations?.size) return;

    const { ownerUserId: _privateOwner, ...publicEvent } = event;
    if (publicEvent.bot) {
      const { ownerUserId: _privateBotOwner, ...publicBot } = publicEvent.bot;
      publicEvent.bot = publicBot;
    }
    const message = JSON.stringify(publicEvent);
    for (const registration of [...registrations]) {
      const { socket } = registration;
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (socket.bufferedAmount > this.maxBufferedBytes) {
        socket.close(1013, "Trading event client is too slow");
        this.remove(ownerUserId, registration);
        continue;
      }
      socket.send(message);
    }
  }

  disconnectOwner(ownerUserId: string, reason = "Trading access changed"): void {
    const registrations = this.clients.get(ownerUserId);
    if (!registrations) return;
    for (const registration of [...registrations]) {
      if (registration.socket.readyState === WebSocket.OPEN || registration.socket.readyState === WebSocket.CONNECTING) {
        registration.socket.close(1008, reason);
      }
      this.remove(ownerUserId, registration);
    }
  }

  /** Close only sockets authenticated by one revoked login session. */
  disconnectSession(sessionIdHash: string, reason = "Trading session revoked"): void {
    if (!sessionIdHash) return;
    for (const [ownerUserId, registrations] of [...this.clients]) {
      for (const registration of [...registrations]) {
        if (registration.sessionIdHash !== sessionIdHash) continue;
        if (registration.socket.readyState === WebSocket.OPEN || registration.socket.readyState === WebSocket.CONNECTING) {
          registration.socket.close(1008, reason);
        }
        this.remove(ownerUserId, registration);
      }
    }
  }

  close(): void {
    for (const ownerUserId of [...this.clients.keys()]) this.disconnectOwner(ownerUserId, "Server shutting down");
  }

  clientCount(ownerUserId: string): number {
    return this.clients.get(ownerUserId)?.size ?? 0;
  }

  private remove(ownerUserId: string, registration: ClientRegistration): void {
    if (registration.expiryTimer) clearTimeout(registration.expiryTimer);
    const registrations = this.clients.get(ownerUserId);
    if (!registrations) return;
    registrations.delete(registration);
    if (registrations.size === 0) this.clients.delete(ownerUserId);
  }
}
