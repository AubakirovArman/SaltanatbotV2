import { useId, useState } from "react";
import { authText } from "../auth/messages";
import type { Locale } from "../i18n";
import { AdminAuditLog } from "./AdminAuditLog";
import { AdminUsersPanel } from "./AdminUsersPanel";

export function AdminCenter({
  currentUserId,
  locale,
  onSessionChanged,
  tradingRoleAssignmentsEnabled
}: {
  currentUserId: string;
  locale: Locale;
  onSessionChanged: () => Promise<void>;
  tradingRoleAssignmentsEnabled: boolean;
}) {
  const [tab, setTab] = useState<"users" | "audit">("users");
  const usersId = useId();
  const auditId = useId();
  return (
    <div className="auth-admin-center">
      <div className="auth-admin-tabs" role="tablist" aria-label={authText(locale, "adminArea")}>
        <button
          type="button"
          id={`${usersId}-tab`}
          role="tab"
          aria-selected={tab === "users"}
          aria-controls={usersId}
          onClick={() => setTab("users")}
        >
          {authText(locale, "usersTab")}
        </button>
        <button
          type="button"
          id={`${auditId}-tab`}
          role="tab"
          aria-selected={tab === "audit"}
          aria-controls={auditId}
          onClick={() => setTab("audit")}
        >
          {authText(locale, "auditTab")}
        </button>
      </div>
      <div id={usersId} role="tabpanel" aria-labelledby={`${usersId}-tab`} hidden={tab !== "users"}>
        {tab === "users" ? (
          <AdminUsersPanel
            currentUserId={currentUserId}
            locale={locale}
            onSessionChanged={onSessionChanged}
            tradingRoleAssignmentsEnabled={tradingRoleAssignmentsEnabled}
          />
        ) : null}
      </div>
      <div id={auditId} role="tabpanel" aria-labelledby={`${auditId}-tab`} hidden={tab !== "audit"}>
        {tab === "audit" ? <AdminAuditLog locale={locale} /> : null}
      </div>
    </div>
  );
}
