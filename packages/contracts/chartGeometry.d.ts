/** Canonical chart drawing geometry shared by canvas, workspace documents and alert evaluators. */
export declare const CHART_GEOMETRY_KINDS_V1: readonly ["horizontal", "trend", "channel"];
export type ChartGeometryKindV1 = (typeof CHART_GEOMETRY_KINDS_V1)[number];
/** A data-space anchor: Unix epoch milliseconds paired with an instrument price. */
export interface ChartAnchorV1 {
    time: number;
    price: number;
}
export interface HorizontalGeometryV1 {
    kind: "horizontal";
    price: number;
}
/** An infinite line through two anchors at distinct times. */
export interface TrendGeometryV1 {
    kind: "trend";
    a: ChartAnchorV1;
    b: ChartAnchorV1;
}
/**
 * A channel IS two lines: the base line through a and b plus the same line translated by width.
 * width is the signed price offset of the parallel line; |width| is the measurable channel width.
 */
export interface ChannelGeometryV1 {
    kind: "channel";
    a: ChartAnchorV1;
    b: ChartAnchorV1;
    width: number;
}
export type ChartGeometryV1 = HorizontalGeometryV1 | TrendGeometryV1 | ChannelGeometryV1;
export declare function parseChartAnchorV1(value: unknown, label?: string): ChartAnchorV1;
export declare function parseHorizontalGeometryV1(value: unknown, label?: string): HorizontalGeometryV1;
export declare function parseTrendGeometryV1(value: unknown, label?: string): TrendGeometryV1;
export declare function parseChannelGeometryV1(value: unknown, label?: string): ChannelGeometryV1;
export declare function parseChartGeometryV1(value: unknown, label?: string): ChartGeometryV1;
