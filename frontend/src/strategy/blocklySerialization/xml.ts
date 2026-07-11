/** Small XML primitives shared by the typed Blockly serializers. */
export function block(type: string, inner: string, next = ""): string {
  return `<block type="${escapeXml(type)}">${inner}${next ? `<next>${next}</next>` : ""}</block>`;
}

export function field(name: string, value: string | number): string {
  return `<field name="${escapeXml(name)}">${escapeXml(String(value))}</field>`;
}

export function value(name: string, inner: string): string {
  return `<value name="${escapeXml(name)}">${inner}</value>`;
}

export function statement(name: string, inner: string): string {
  return inner ? `<statement name="${escapeXml(name)}">${inner}</statement>` : "";
}

export function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
