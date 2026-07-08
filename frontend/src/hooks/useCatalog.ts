import { useEffect, useState } from "react";
import { getCatalog } from "../api/marketClient";
import type { CatalogResponse } from "../types";

interface CatalogState {
  catalog?: CatalogResponse;
  loading: boolean;
  error?: string;
}

export function useCatalog(): CatalogState {
  const [state, setState] = useState<CatalogState>({ loading: true });

  useEffect(() => {
    let alive = true;
    getCatalog()
      .then((catalog) => {
        if (alive) setState({ catalog, loading: false });
      })
      .catch((error: unknown) => {
        if (!alive) return;
        const message = error instanceof Error ? error.message : "Failed to load catalog";
        setState({ loading: false, error: message });
      });

    return () => {
      alive = false;
    };
  }, []);

  return state;
}
