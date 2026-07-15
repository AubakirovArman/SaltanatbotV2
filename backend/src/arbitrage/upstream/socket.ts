import { WebSocket } from "ws";

interface Options {
  url: string;
  name: string;
  onOpen(socket: WebSocket): void;
  /** Return true only after a valid market-data event was accepted. */
  onMessage(value: unknown): boolean;
  onStatus(ok: boolean, message?: string): void;
  heartbeat?: (socket: WebSocket) => void;
  heartbeatMs?: number;
  messageTimeoutMs?: number;
  createSocket?: (url: string) => WebSocket;
  now?: () => number;
  random?: () => number;
}

/** A bounded public socket with heartbeat and exponential reconnect. */
export class ResilientPublicSocket {
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private watchdogTimer?: NodeJS.Timeout;
  private stopped = true;
  private attempt = 0;
  private healthy = false;
  private lastValidMessageAt = 0;

  constructor(private readonly options: Options) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.reconnectTimer = undefined;
    this.heartbeatTimer = undefined;
    this.watchdogTimer = undefined;
    this.healthy = false;
    this.lastValidMessageAt = 0;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "idle");
  }

  restart() {
    const running = !this.stopped;
    this.stop();
    if (running) this.start();
  }

  private connect() {
    if (this.stopped) return;
    this.options.onStatus(false, `${this.options.name} connecting`);
    const socket = (this.options.createSocket ?? ((url) => new WebSocket(url, { maxPayload: 2 * 1024 * 1024 })))(this.options.url);
    this.socket = socket;
    socket.on("open", () => {
      if (socket !== this.socket || this.stopped) return;
      this.healthy = false;
      this.lastValidMessageAt = (this.options.now ?? Date.now)();
      this.options.onStatus(false, `${this.options.name} awaiting market data`);
      this.options.onOpen(socket);
      if (this.options.heartbeat) {
        this.heartbeatTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) this.options.heartbeat?.(socket);
        }, this.options.heartbeatMs ?? 20_000);
        this.heartbeatTimer.unref?.();
      }
      const timeoutMs = this.options.messageTimeoutMs ?? 15_000;
      this.watchdogTimer = setInterval(() => {
        if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) return;
        if ((this.options.now ?? Date.now)() - this.lastValidMessageAt <= timeoutMs) return;
        this.healthy = false;
        this.options.onStatus(false, `${this.options.name} market data timed out`);
        socket.terminate();
      }, Math.max(1_000, Math.min(5_000, Math.floor(timeoutMs / 2))));
      this.watchdogTimer.unref?.();
    });
    socket.on("message", (data) => {
      try {
        if (!this.options.onMessage(JSON.parse(data.toString()))) return;
        this.lastValidMessageAt = (this.options.now ?? Date.now)();
        this.attempt = 0;
        if (!this.healthy) {
          this.healthy = true;
          this.options.onStatus(true);
        }
      } catch {
        // A malformed public tick is ignored; the last valid quote remains bounded by REST refresh.
      }
    });
    socket.on("error", (error) => this.options.onStatus(false, error.message));
    socket.on("close", () => {
      if (socket !== this.socket) return;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (this.watchdogTimer) clearInterval(this.watchdogTimer);
      this.heartbeatTimer = undefined;
      this.watchdogTimer = undefined;
      this.healthy = false;
      this.socket = undefined;
      if (this.stopped) return;
      this.options.onStatus(false, `${this.options.name} reconnecting`);
      const baseDelay = Math.min(30_000, 500 * 2 ** Math.min(this.attempt++, 6));
      const jitter = 0.8 + (this.options.random ?? Math.random)() * 0.4;
      const delay = Math.round(baseDelay * jitter);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
      this.reconnectTimer.unref?.();
    });
  }
}
