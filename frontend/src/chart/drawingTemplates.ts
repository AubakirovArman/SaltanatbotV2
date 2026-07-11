import type { DrawingStyle, ShapeTool } from "./drawings";

const KEY = "sbv2:drawing-templates:v1";

export interface DrawingTemplate {
  id: string;
  name: string;
  tool: ShapeTool;
  style: DrawingStyle;
  createdAt: number;
}

export function loadDrawingTemplates(): DrawingTemplate[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is DrawingTemplate => item && typeof item.id === "string" && typeof item.name === "string" && typeof item.tool === "string" && item.style && typeof item.style === "object");
  } catch {
    return [];
  }
}

export function saveDrawingTemplate(template: DrawingTemplate): DrawingTemplate[] {
  const next = [template, ...loadDrawingTemplates().filter((item) => item.id !== template.id)].slice(0, 30);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* runtime-only fallback */ }
  return next;
}

export function removeDrawingTemplate(id: string): DrawingTemplate[] {
  const next = loadDrawingTemplates().filter((item) => item.id !== id);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* runtime-only fallback */ }
  return next;
}
