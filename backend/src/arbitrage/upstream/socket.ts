import { WebSocket } from "ws";

interface Options {
  url: string;
  name: string;
  onOpen(socket: WebSocket): void;
  onMessage(value: unknown): void;
  onStatus(ok: boolean, message?: string): void;
  heartbeat?: (socket: WebSocket) => void;
  heartbeatMs?: number;
  createSocket?: (url: string) => WebSocket;
}

/** A bounded public socket with heartbeat and exponential reconnect. */
export class ResilientPublicSocket {
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private stopped = true;
  private attempt = 0;

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
    this.reconnectTimer = undefined;
    this.heartbeatTimer = undefined;
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
    const socket = (this.options.createSocket ?? ((url) => new WebSocket(url, { maxPayload: 2 * 1024 * 1024 })))(this.options.url);
    this.socket = socket;
    socket.on("open", () => {
      if (socket !== this.socket || this.stopped) return;
      this.attempt = 0;
      this.options.onStatus(true);
      this.options.onOpen(socket);
      if (this.options.heartbeat) {
        this.heartbeatTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) this.options.heartbeat?.(socket);
        }, this.options.heartbeatMs ?? 20_000);
        this.heartbeatTimer.unref?.();
      }
    });
    socket.on("message", (data) => {
      try {
        this.options.onMessage(JSON.parse(data.toString()));
      } catch {
        // A malformed public tick is ignored; the last valid quote remains bounded by REST refresh.
      }
    });
    socket.on("error", (error) => this.options.onStatus(false, error.message));
    socket.on("close", () => {
      if (socket !== this.socket) return;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
      this.socket = undefined;
      if (this.stopped) return;
      this.options.onStatus(false, `${this.options.name} reconnecting`);
      const delay = Math.min(30_000, 500 * 2 ** Math.min(this.attempt++, 6));
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
      this.reconnectTimer.unref?.();
    });
  }
}
