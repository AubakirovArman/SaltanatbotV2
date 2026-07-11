import type { Stmt } from "./ir";

export interface PreviewTable {
  id: string;
  columns: string[];
  rows: { label: string; values: (number | null)[] }[];
}

/** Build stable, accessible tables from the last finite value emitted by every
 * display-only metric statement. Nested control-flow keeps source order. */
export function buildPreviewTables(stmts: Stmt[], values: Map<Stmt, number>): PreviewTable[] {
  const metrics: Extract<Stmt, { k: "metric" }>[] = [];
  collectMetrics(stmts, metrics);

  const groups = new Map<string, { columns: string[]; rows: Map<string, Map<string, number>> }>();
  for (const metric of metrics) {
    const value = values.get(metric);
    if (value === undefined) continue;
    const group = groups.get(metric.table) ?? {
      columns: [],
      rows: new Map<string, Map<string, number>>()
    };
    if (!group.columns.includes(metric.column)) group.columns.push(metric.column);
    const row = group.rows.get(metric.label) ?? new Map<string, number>();
    row.set(metric.column, value);
    group.rows.set(metric.label, row);
    groups.set(metric.table, group);
  }

  return [...groups].map(([id, group]) => ({
    id,
    columns: group.columns,
    rows: [...group.rows].map(([label, row]) => ({
      label,
      values: group.columns.map((column) => row.get(column) ?? null)
    }))
  }));
}

function collectMetrics(stmts: Stmt[], target: Extract<Stmt, { k: "metric" }>[]) {
  for (const stmt of stmts) {
    if (stmt.k === "metric") target.push(stmt);
    else if (stmt.k === "if") {
      collectMetrics(stmt.then, target);
      for (const clause of stmt.elifs ?? []) collectMetrics(clause.then, target);
      if (stmt.else) collectMetrics(stmt.else, target);
    } else if (stmt.k === "repeat" || stmt.k === "while" || stmt.k === "for") {
      collectMetrics(stmt.body, target);
    }
  }
}
