import { Component, type ErrorInfo, type ReactNode } from "react";
import { loadLocale, localized } from "../i18n";
import { canManageApplicationShellFiles, claimAutomaticApplicationShellRecovery, isRecoverableApplicationAssetError, refreshApplicationFiles } from "./startupRecovery";

interface AppErrorBoundaryState {
  failed: boolean;
  recovering: boolean;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { failed: false, recovering: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true, recovering: false };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo) {
    if (!isRecoverableApplicationAssetError(error) || !claimAutomaticApplicationShellRecovery()) return;
    this.setState({ recovering: true });
    void refreshApplicationFiles();
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const copy = recoveryCopy(loadLocale());
    const canRefreshApplicationFiles = canManageApplicationShellFiles();
    return (
      <main className="startup-recovery" role="alert" aria-labelledby="startup-recovery-title">
        <div className="startup-recovery-card">
          <img src="/logo.svg" width="52" height="52" alt="" />
          <p className="startup-recovery-kicker">SaltanatbotV2</p>
          <h1 id="startup-recovery-title">{this.state.recovering ? copy.refreshing : copy.title}</h1>
          <p>{copy.help}</p>
          <p className="startup-recovery-note">{copy.preserved}</p>
          {!this.state.recovering && (
            <div className="startup-recovery-actions">
              <button type="button" className="primary" onClick={() => this.setState({ failed: false, recovering: false })}>
                {copy.retry}
              </button>
              <button type="button" onClick={() => window.location.reload()}>
                {copy.reload}
              </button>
              {canRefreshApplicationFiles && (
                <button
                  type="button"
                  onClick={() => {
                    this.setState({ recovering: true });
                    void refreshApplicationFiles();
                  }}
                >
                  {copy.refresh}
                </button>
              )}
            </div>
          )}
          {canRefreshApplicationFiles && <p className="startup-recovery-footnote">{copy.refreshHelp}</p>}
        </div>
      </main>
    );
  }
}

function recoveryCopy(locale: ReturnType<typeof loadLocale>) {
  return localized(locale, {
    en: {
      title: "The application could not start",
      refreshing: "Refreshing application files…",
      help: "A browser or application error interrupted the interface.",
      preserved: "Saved charts, strategies, exchange settings and trading records were not deleted.",
      retry: "Try the interface again",
      reload: "Reload page",
      refresh: "Refresh application files",
      refreshHelp: "Refreshing removes only SaltanatbotV2 offline shell files and its service-worker registration. It does not clear local application data."
    },
    ru: {
      title: "Не удалось запустить приложение",
      refreshing: "Обновляем файлы приложения…",
      help: "Ошибка браузера или приложения прервала загрузку интерфейса.",
      preserved: "Сохранённые графики, стратегии, настройки бирж и торговые записи не удалены.",
      retry: "Повторить запуск интерфейса",
      reload: "Перезагрузить страницу",
      refresh: "Обновить файлы приложения",
      refreshHelp: "Обновление удаляет только offline-shell SaltanatbotV2 и регистрацию его service worker. Локальные данные приложения не очищаются."
    },
    kk: {
      title: "Қолданбаны іске қосу мүмкін болмады",
      refreshing: "Қолданба файлдары жаңартылуда…",
      help: "Browser немесе қолданба қатесі интерфейстің жүктелуін тоқтатты.",
      preserved: "Сақталған графиктер, стратегиялар, биржа баптаулары және сауда жазбалары жойылған жоқ.",
      retry: "Интерфейсті қайта іске қосу",
      reload: "Бетті қайта жүктеу",
      refresh: "Қолданба файлдарын жаңарту",
      refreshHelp: "Жаңарту тек SaltanatbotV2 offline shell файлдарын және оның service worker тіркеуін жояды. Жергілікті қолданба деректері тазаланбайды."
    }
  });
}
