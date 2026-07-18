import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { paperPortfolioText, paperRobotActionText } from "../../../i18n/paperPortfolio";
import type { Locale } from "../../../i18n";
import type { PaperMoney, PaperRobotAction, PaperRobotProjection } from "../../paperPortfolioTypes";
import { toCanonicalPositivePaperMoney } from "../../paperPortfolioMoney";

export type PortfolioDialogKind = "create" | "rename" | "archive" | "reset";

export function PortfolioLifecycleDialog({
  kind,
  locale,
  portfolioName = "",
  initialCapital = "10000.000000",
  busy,
  returnFocus,
  onClose,
  onCreate,
  onRename,
  onArchive,
  onReset
}: {
  kind: PortfolioDialogKind;
  locale: Locale;
  portfolioName?: string;
  initialCapital?: PaperMoney;
  busy: boolean;
  returnFocus?: HTMLElement | null;
  onClose: () => void;
  onCreate: (name: string, initialCapital: PaperMoney) => Promise<void>;
  onRename: (name: string) => Promise<void>;
  onArchive: (confirmName: string) => Promise<void>;
  onReset: (confirmName: string, initialCapital?: PaperMoney) => Promise<void>;
}) {
  const [name, setName] = useState(kind === "create" ? "" : portfolioName);
  const [capital, setCapital] = useState(toEditableMoney(initialCapital));
  const [validation, setValidation] = useState<string>();
  const destructive = kind === "archive" || kind === "reset";
  const title = kind === "create" ? paperPortfolioText(locale, "createPortfolio")
    : kind === "rename" ? paperPortfolioText(locale, "renamePortfolio")
      : paperPortfolioText(locale, kind === "archive" ? "archiveTitle" : "resetTitle");

  const submit = async () => {
    const normalizedName = name.trim();
    if (!normalizedName) return;
    if (destructive && normalizedName !== portfolioName) {
      setValidation(paperPortfolioText(locale, "nameMismatch"));
      return;
    }
    const normalizedMoney = kind === "create" || kind === "reset" ? toCanonicalMoney(capital) : undefined;
    if ((kind === "create" || kind === "reset") && !normalizedMoney) {
      setValidation(paperPortfolioText(locale, "invalidMoney"));
      return;
    }
    setValidation(undefined);
    if (kind === "create") await onCreate(normalizedName, normalizedMoney!);
    if (kind === "rename") await onRename(normalizedName);
    if (kind === "archive") await onArchive(normalizedName);
    if (kind === "reset") await onReset(normalizedName, normalizedMoney);
  };

  return (
    <AccessibleDialog title={title} locale={locale} busy={busy} returnFocus={returnFocus} onClose={onClose} onConfirm={submit}>
      {kind === "archive" && <p>{paperPortfolioText(locale, "archiveHint")}</p>}
      {kind === "reset" && <p>{paperPortfolioText(locale, "resetHint")}</p>}
      <label>
        <span>{destructive ? paperPortfolioText(locale, "confirmName") : paperPortfolioText(locale, "name")}</span>
        <input autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
      </label>
      {(kind === "create" || kind === "reset") && (
        <label>
          <span>{paperPortfolioText(locale, "initialCapital")}</span>
          <input inputMode="decimal" value={capital} onChange={(event) => setCapital(event.target.value)} disabled={busy} />
        </label>
      )}
      {validation && <p className="paper-dialog-validation" role="alert">{validation}</p>}
    </AccessibleDialog>
  );
}

export function RobotActionDialog({
  locale,
  robot,
  robotName,
  action,
  busy,
  returnFocus,
  onClose,
  onConfirm
}: {
  locale: Locale;
  robot: PaperRobotProjection;
  robotName: string;
  action: PaperRobotAction;
  busy: boolean;
  returnFocus?: HTMLElement | null;
  onClose: () => void;
  onConfirm: (robot: PaperRobotProjection, action: PaperRobotAction) => Promise<void>;
}) {
  return (
    <AccessibleDialog
      title={paperPortfolioText(locale, "confirmAction")}
      locale={locale}
      busy={busy}
      returnFocus={returnFocus}
      onClose={onClose}
      onConfirm={() => onConfirm(robot, action)}
      confirmLabel={paperRobotActionText(locale, action)}
    >
      <p><strong>{robotName}</strong> · {paperRobotActionText(locale, action)}</p>
      <p>{paperPortfolioText(locale, "confirmActionHint")}</p>
      <dl className="paper-dialog-revisions">
        <div><dt>{paperPortfolioText(locale, "epoch")}</dt><dd>{robot.ledgerEpoch}</dd></div>
        <div><dt>{paperPortfolioText(locale, "revision")}</dt><dd>{robot.botRevision}</dd></div>
      </dl>
    </AccessibleDialog>
  );
}

export function AccessibleDialog({
  title,
  locale,
  busy,
  returnFocus,
  onClose,
  onConfirm,
  confirmLabel,
  children
}: {
  title: string;
  locale: Locale;
  busy: boolean;
  returnFocus?: HTMLElement | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  confirmLabel?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const capturedFocus = useRef<HTMLElement | null>(returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  busyRef.current = busy;
  onCloseRef.current = onClose;

  useEffect(() => {
    const panel = panelRef.current;
    const focus = () => panel?.querySelector<HTMLElement>("input, button")?.focus();
    const frame = window.requestAnimationFrame(focus);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) onCloseRef.current();
      if (event.key === "Tab" && panel) trapFocus(event, panel);
    };
    document.addEventListener("keydown", keydown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", keydown);
      window.requestAnimationFrame(() => capturedFocus.current?.focus());
    };
  }, []);

  return (
    <div className="paper-dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section ref={panelRef} className="paper-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header><h3 id={titleId}>{title}</h3></header>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void onConfirm();
        }}>
          <div className="paper-dialog-body">{children}</div>
          <footer>
            <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>{paperPortfolioText(locale, "cancel")}</button>
            <button type="submit" className="run-button" disabled={busy}>{busy ? paperPortfolioText(locale, "busy") : confirmLabel ?? paperPortfolioText(locale, "confirm")}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export function toCanonicalMoney(value: string): PaperMoney | undefined {
  return toCanonicalPositivePaperMoney(value);
}

function toEditableMoney(value: PaperMoney): string {
  return value.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function trapFocus(event: KeyboardEvent, panel: HTMLElement): void {
  const focusable = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')];
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
