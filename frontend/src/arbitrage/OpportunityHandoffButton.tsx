import { Check, Send, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MarketOpportunityEnvelope } from "@saltanatbotv2/arbitrage-sdk";
import type { Locale } from "../i18n";
import { handoffMarketOpportunity } from "./marketOpportunityHandoff";
import { opportunityHandoffText } from "./opportunityHandoffText";

interface Props {
  locale: Locale;
  name: string;
  disabled?: boolean;
  disabledReason?: string;
  createOpportunity(): MarketOpportunityEnvelope;
}

export function OpportunityHandoffButton({ locale, name, disabled = false, disabledReason, createOpportunity }: Props) {
  const [status, setStatus] = useState<"idle" | "sent" | "failed">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout>>();
  const label = disabled && disabledReason ? disabledReason : opportunityHandoffText(locale, "sendTitle", { name });

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    []
  );

  const announce = (next: "sent" | "failed") => {
    setStatus(next);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setStatus("idle"), 4_000);
  };

  return (
    <>
      <button
        className="arb-opportunity-handoff"
        type="button"
        disabled={disabled}
        aria-label={label}
        title={label}
        onClick={() => {
          try {
            handoffMarketOpportunity(createOpportunity());
            announce("sent");
          } catch {
            announce("failed");
          }
        }}
      >
        {status === "sent" ? <Check size={15} aria-hidden="true" /> : status === "failed" ? <TriangleAlert size={15} aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}
        <span className="sr-only">{opportunityHandoffText(locale, "send")}</span>
      </button>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {status === "sent" ? opportunityHandoffText(locale, "sent", { name }) : status === "failed" ? opportunityHandoffText(locale, "failed", { name }) : ""}
      </span>
    </>
  );
}
