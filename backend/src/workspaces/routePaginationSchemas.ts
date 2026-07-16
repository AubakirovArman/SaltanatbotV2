import { z } from "zod";
import {
  WORKSPACE_LIST_PAGE_MAX_ITEMS,
  WORKSPACE_REVISION_PAGE_MAX_ITEMS
} from "./workspacePagination.js";

export const workspaceListQuerySchema = z
  .object({
    status: z.enum(["active", "archived", "all"]).optional(),
    includeArchived: z.enum(["true", "false"]).optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(WORKSPACE_LIST_PAGE_MAX_ITEMS)
      .optional()
  })
  .strict();

export const workspaceRevisionListQuerySchema = z
  .object({
    cursor: z.coerce
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(WORKSPACE_REVISION_PAGE_MAX_ITEMS)
      .optional()
  })
  .strict();
