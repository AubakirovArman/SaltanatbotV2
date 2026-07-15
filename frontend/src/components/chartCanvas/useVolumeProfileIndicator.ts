import { useState } from "react";
import type { VolumeProfileIndicatorControl } from "../ChartIndicatorOverlay";
import { useVolumeProfileSource } from "./useVolumeProfileSource";

type VolumeProfileIndicatorOptions = Omit<Parameters<typeof useVolumeProfileSource>[0], "enabled">;

export function useVolumeProfileIndicator(options: VolumeProfileIndicatorOptions) {
  const [added, setAdded] = useState(false);
  const [visible, setVisible] = useState(false);
  const source = useVolumeProfileSource({ ...options, enabled: visible });
  const control: VolumeProfileIndicatorControl = {
    added,
    visible,
    chartTimeframe: options.chartTimeframe,
    state: source,
    onAdd: () => {
      setAdded(true);
      setVisible(true);
    },
    onVisibleChange: setVisible,
    onRemove: () => {
      setAdded(false);
      setVisible(false);
    }
  };
  return { control, source, visible };
}
