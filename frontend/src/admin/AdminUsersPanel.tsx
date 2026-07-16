import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { listUsers } from "../auth/client";
import { authText } from "../auth/messages";
import { authErrorMessage } from "../auth/presentation";
import type { AdminUserFilters, AdminUserPage, AppRole, AuthUser, TradingRole, UserStatus } from "../auth/types";
import type { Locale } from "../i18n";
import { AdminPagination } from "./AdminPagination";
import { AdminUserCard } from "./AdminUserCard";

const PAGE_SIZE = 25;

export function AdminUsersPanel({
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
  const titleId = useId();
  const [result, setResult] = useState<AdminUserPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [announcement, setAnnouncement] = useState("");
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"" | UserStatus>("");
  const [appRole, setAppRole] = useState<"" | AppRole>("");
  const [tradingRole, setTradingRole] = useState<"" | TradingRole>("");
  const [page, setPage] = useState(1);

  const filters: AdminUserFilters = {
    query,
    status: status || undefined,
    appRole: appRole || undefined,
    tradingRole: tradingRole || undefined,
    page,
    pageSize: PAGE_SIZE
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await listUsers(filters);
      setResult(next);
      const lastPage = Math.max(1, next.pagination.totalPages);
      if (page > lastPage) setPage(lastPage);
    } catch (cause) {
      setError(authErrorMessage(locale, cause));
    } finally {
      setLoading(false);
    }
  }, [appRole, locale, page, query, status, tradingRole]);

  useEffect(() => {
    void load();
  }, [load]);

  const applySearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    setQuery(queryDraft.trim());
  };

  const clear = () => {
    setQueryDraft("");
    setQuery("");
    setStatus("");
    setAppRole("");
    setTradingRole("");
    setPage(1);
  };

  const refreshAfterMutation = async (user: AuthUser) => {
    setResult((current) => current ? { ...current, users: current.users.map((item) => item.id === user.id ? user : item) } : current);
    await load();
  };

  const users = result?.users ?? [];
  return (
    <section className="auth-admin-section" aria-labelledby={titleId}>
      <header className="auth-admin-heading">
        <div>
          <h3 id={titleId}>{authText(locale, "usersTitle")}</h3>
          <p>{authText(locale, "usersHelp")}</p>
          {!tradingRoleAssignmentsEnabled ? <p className="auth-migration-note">{authText(locale, "tradingMigrationPending")}</p> : null}
        </div>
        <button type="button" disabled={loading} onClick={() => void load()}>{authText(locale, "reloadUsers")}</button>
      </header>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
      <form className="auth-user-filters" role="search" aria-label={authText(locale, "userFilters")} onSubmit={applySearch}>
        <label>
          <span>{authText(locale, "searchUsers")}</span>
          <input type="search" value={queryDraft} autoComplete="off" maxLength={64} placeholder={authText(locale, "searchUsersHint")} onChange={(event) => setQueryDraft(event.target.value)} />
        </label>
        <label>
          <span>{authText(locale, "filterStatus")}</span>
          <select value={status} onChange={(event) => { setStatus(event.target.value as typeof status); setPage(1); }}>
            <option value="">{authText(locale, "allStatuses")}</option>
            <option value="pending">{authText(locale, "pending")}</option>
            <option value="active">{authText(locale, "active")}</option>
            <option value="disabled">{authText(locale, "disabled")}</option>
          </select>
        </label>
        <label>
          <span>{authText(locale, "filterAppRole")}</span>
          <select value={appRole} onChange={(event) => { setAppRole(event.target.value as typeof appRole); setPage(1); }}>
            <option value="">{authText(locale, "allRoles")}</option>
            <option value="user">{authText(locale, "userRole")}</option>
            <option value="admin">{authText(locale, "adminRole")}</option>
          </select>
        </label>
        <label>
          <span>{authText(locale, "filterTradingRole")}</span>
          <select value={tradingRole} onChange={(event) => { setTradingRole(event.target.value as typeof tradingRole); setPage(1); }}>
            <option value="">{authText(locale, "allRoles")}</option>
            <option value="none">{authText(locale, "noTrading")}</option>
            <option value="read-only">{authText(locale, "readOnly")}</option>
            <option value="paper-trade">{authText(locale, "paperTrade")}</option>
            <option value="live-trade">{authText(locale, "dormantLiveTrade")}</option>
          </select>
        </label>
        <div className="auth-filter-actions">
          <button type="submit" disabled={loading}>{authText(locale, "applyFilters")}</button>
          <button type="button" disabled={loading} onClick={clear}>{authText(locale, "clearFilters")}</button>
        </div>
        <output aria-live="polite">{authText(locale, "usersShown")}: {users.length} / {result?.pagination.total ?? 0}</output>
      </form>
      {error ? <p className="auth-form-error" role="alert">{error}</p> : null}
      {loading && !result ? <p className="auth-users-loading" role="status">{authText(locale, "loading")}</p> : null}
      {result && users.length === 0 ? <p className="auth-users-empty">{authText(locale, "noMatchingUsers")}</p> : null}
      {users.length > 0 ? (
        <div className="auth-user-list">
          {users.map((user) => (
            <AdminUserCard
              key={user.id}
              currentUserId={currentUserId}
              locale={locale}
              onAnnounce={setAnnouncement}
              onChange={refreshAfterMutation}
              onSessionChanged={onSessionChanged}
              tradingRoleAssignmentsEnabled={tradingRoleAssignmentsEnabled}
              user={user}
            />
          ))}
        </div>
      ) : null}
      {result ? <AdminPagination ariaLabel={authText(locale, "usersTitle")} disabled={loading} locale={locale} onPage={setPage} pagination={result.pagination} /> : null}
    </section>
  );
}
