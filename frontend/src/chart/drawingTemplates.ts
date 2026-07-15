import type { DrawingStyle, ShapeTool } from "./drawings";
import { readTenantLocalItem, writeTenantLocalItem } from "../app/tenantLocalStorage";

const KEY = "sbv2:drawing-templates:v1";

export interface DrawingTemplate {
  id: string;
  name: string;
  tool: ShapeTool;
  style: DrawingStyle;
  createdAt: number;
}

export function loadDrawingTemplates(ownerId?: string): DrawingTemplate[] {
  try {
    const value = JSON.parse(readTenantLocalItem(localStorage, KEY, ownerId) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is DrawingTemplate => item && typeof item.id === "string" && typeof item.name === "string" && typeof item.tool === "string" && item.style && typeof item.style === "object");
  } catch {
    return [];
  }
}

export function saveDrawingTemplate(template: DrawingTemplate, ownerId?: string): DrawingTemplate[] {
  const next = [template, ...loadDrawingTemplates(ownerId).filter((item) => item.id !== template.id)].slice(0, 30);
  try {
    writeTenantLocalItem(localStorage, KEY, JSON.stringify(next), ownerId);
  } catch {
    /* runtime-only fallback */
  }
  return next;
}

export function removeDrawingTemplate(id: string, ownerId?: string): DrawingTemplate[] {
  const next = loadDrawingTemplates(ownerId).filter((item) => item.id !== id);
  try {
    writeTenantLocalItem(localStorage, KEY, JSON.stringify(next), ownerId);
  } catch {
    /* runtime-only fallback */
  }
  return next;
}
