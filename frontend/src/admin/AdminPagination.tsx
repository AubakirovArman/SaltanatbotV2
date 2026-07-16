import type { Locale } from "../i18n";
import { authText } from "../auth/messages";
import type { Pagination } from "../auth/types";

export function AdminPagination({
  ariaLabel,
  disabled,
  locale,
  onPage,
  pagination
}: {
  ariaLabel: string;
  disabled: boolean;
  locale: Locale;
  onPage: (page: number) => void;
  pagination: Pagination;
}) {
  if (pagination.totalPages <= 1) return null;
  return (
    <nav className="auth-pagination" aria-label={ariaLabel}>
      <button type="button" disabled={disabled || pagination.page <= 1} onClick={() => onPage(pagination.page - 1)}>
        {authText(locale, "previousPage")}
      </button>
      <span>{authText(locale, "pageOf").replace("{page}", String(pagination.page)).replace("{total}", String(pagination.totalPages))}</span>
      <button type="button" disabled={disabled || pagination.page >= pagination.totalPages} onClick={() => onPage(pagination.page + 1)}>
        {authText(locale, "nextPage")}
      </button>
    </nav>
  );
}
