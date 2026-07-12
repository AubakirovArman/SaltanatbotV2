export interface SharedSocketClient {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  close(): void;
}

interface SharedSocketResource {
  url: string;
  socket: WebSocket;
  clients: Set<SharedSocketClient>;
}

type WebSocketFactory = (url: string) => WebSocket;

const OPEN = 1;
const CLOSING = 2;

/** Shares one physical WebSocket per URL while preserving per-consumer handlers. */
export class SharedWebSocketPool {
  private readonly resources = new Map<string, SharedSocketResource>();

  constructor(private readonly createSocket: WebSocketFactory = (url) => new WebSocket(url)) {}

  connect(url: string): SharedSocketClient {
    let resource = this.resources.get(url);
    if (!resource || resource.socket.readyState >= CLOSING) {
      if (resource) this.resources.delete(url);
      resource = this.createResource(url);
      this.resources.set(url, resource);
    }

    const client: SharedSocketClient = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      close: () => this.release(resource, client)
    };
    resource.clients.add(client);

    if (resource.socket.readyState === OPEN) {
      queueMicrotask(() => {
        if (resource.socket.readyState === OPEN && resource.clients.has(client)) client.onopen?.(new Event("open"));
      });
    }
    return client;
  }

  activeConnectionCount() {
    return this.resources.size;
  }

  closeAll() {
    const resources = [...this.resources.values()];
    this.resources.clear();
    for (const resource of resources) {
      resource.clients.clear();
      if (resource.socket.readyState < CLOSING) resource.socket.close();
    }
  }

  private createResource(url: string): SharedSocketResource {
    const socket = this.createSocket(url);
    const resource: SharedSocketResource = { url, socket, clients: new Set() };
    socket.onopen = (event) => this.broadcast(resource, "onopen", event);
    socket.onmessage = (event) => this.broadcast(resource, "onmessage", event);
    socket.onerror = (event) => this.broadcast(resource, "onerror", event);
    socket.onclose = (event) => {
      if (this.resources.get(url) === resource) this.resources.delete(url);
      this.broadcast(resource, "onclose", event);
      resource.clients.clear();
    };
    return resource;
  }

  private release(resource: SharedSocketResource, client: SharedSocketClient) {
    if (!resource.clients.delete(client) || resource.clients.size > 0) return;
    if (this.resources.get(resource.url) === resource) this.resources.delete(resource.url);
    if (resource.socket.readyState < CLOSING) resource.socket.close();
  }

  private broadcast<K extends "onopen" | "onmessage" | "onerror" | "onclose">(
    resource: SharedSocketResource,
    handler: K,
    event: Parameters<NonNullable<SharedSocketClient[K]>>[0]
  ) {
    for (const client of [...resource.clients]) {
      const callback = client[handler] as ((value: typeof event) => void) | null;
      callback?.(event);
    }
  }
}

export const marketWebSocketPool = new SharedWebSocketPool();
