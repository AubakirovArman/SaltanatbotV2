export interface DueIndexRoute {
  id: string;
  spotInstrumentId: string;
  derivativeInstrumentId: string;
}

export interface DueIndexPosition {
  routeId: string;
  dueAt: number;
  openEventIndex: number;
}

type PendingDuePosition = DueIndexPosition;

/**
 * Maintains future positions in a min-heap and failed due positions by leg.
 * A depth event therefore examines newly due positions plus positions that
 * depend on the changed book, never the full configured route universe.
 */
export class DuePositionIndex {
  private readonly routes = new Map<string, DueIndexRoute>();
  private readonly future: PendingDuePosition[] = [];
  private readonly dueByInstrument = new Map<string, Set<string>>();

  constructor(routes: DueIndexRoute[]) {
    for (const route of routes) this.routes.set(route.id, route);
  }

  add(position: DueIndexPosition) {
    this.future.push({ ...position });
    this.siftUp(this.future.length - 1);
  }

  candidates(logicalTime: number, changedInstrumentId: string): string[] {
    const result = new Set<string>();
    while (this.future[0] && this.future[0].dueAt <= logicalTime) {
      const position = this.pop()!;
      this.indexDue(position.routeId);
      result.add(position.routeId);
    }
    for (const routeId of this.dueByInstrument.get(changedInstrumentId) ?? []) result.add(routeId);
    return [...result].sort((left, right) => left.localeCompare(right));
  }

  remove(routeId: string) {
    const route = this.routes.get(routeId);
    if (!route) return;
    this.dueByInstrument.get(route.spotInstrumentId)?.delete(routeId);
    this.dueByInstrument.get(route.derivativeInstrumentId)?.delete(routeId);
  }

  get pendingCount() {
    return this.future.length;
  }

  get indexedDueCount() {
    const values = new Set<string>();
    for (const routeIds of this.dueByInstrument.values()) for (const routeId of routeIds) values.add(routeId);
    return values.size;
  }

  private indexDue(routeId: string) {
    const route = this.routes.get(routeId);
    if (!route) throw new Error(`cannot index unknown due route ${routeId}`);
    for (const instrumentId of [route.spotInstrumentId, route.derivativeInstrumentId]) {
      const values = this.dueByInstrument.get(instrumentId) ?? new Set<string>();
      values.add(routeId);
      this.dueByInstrument.set(instrumentId, values);
    }
  }

  private pop() {
    const first = this.future[0];
    const last = this.future.pop();
    if (this.future.length > 0 && last) {
      this.future[0] = last;
      this.siftDown(0);
    }
    return first;
  }

  private siftUp(start: number) {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (comparePending(this.future[parent]!, this.future[index]!) <= 0) break;
      [this.future[parent], this.future[index]] = [this.future[index]!, this.future[parent]!];
      index = parent;
    }
  }

  private siftDown(start: number) {
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (this.future[left] && comparePending(this.future[left]!, this.future[smallest]!) < 0) smallest = left;
      if (this.future[right] && comparePending(this.future[right]!, this.future[smallest]!) < 0) smallest = right;
      if (smallest === index) return;
      [this.future[index], this.future[smallest]] = [this.future[smallest]!, this.future[index]!];
      index = smallest;
    }
  }
}

function comparePending(left: PendingDuePosition, right: PendingDuePosition) {
  return left.dueAt - right.dueAt || left.routeId.localeCompare(right.routeId) || left.openEventIndex - right.openEventIndex;
}
