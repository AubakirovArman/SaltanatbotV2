import { useEffect, useState } from "react";

export const MOBILE_SHELL_MEDIA_QUERY = "(max-width: 760px), (pointer: coarse) and (max-height: 520px)";

/** Reactive CSS media-query state without a resize listener or layout measurement. */
export function useMediaQuery(query: string) {
  const supported = typeof matchMedia === "function";
  const [matches, setMatches] = useState(() => supported && matchMedia(query).matches);

  useEffect(() => {
    if (!supported) return;
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query, supported]);

  return matches;
}
