(() => {
  const copies = {
    en: { title: "Starting SaltanatbotV2…", help: "Loading the chart, saved workspace and market connections.", delayed: "Startup is taking longer than expected", delayedHelp: "The interface module may be stale or unavailable. Your saved application data has not been deleted.", reload: "Reload page", refresh: "Refresh application files", footnote: "Refreshing removes only SaltanatbotV2 offline shell files and its service-worker registration." },
    ru: { title: "Запускаем SaltanatbotV2…", help: "Загружаем график, сохранённое рабочее пространство и подключения к рынкам.", delayed: "Запуск занимает больше времени, чем ожидалось", delayedHelp: "Модуль интерфейса может быть устаревшим или недоступным. Сохранённые данные приложения не удалены.", reload: "Перезагрузить страницу", refresh: "Обновить файлы приложения", footnote: "Обновление удаляет только offline-shell SaltanatbotV2 и регистрацию его service worker." },
    kk: { title: "SaltanatbotV2 іске қосылуда…", help: "График, сақталған жұмыс кеңістігі және market байланыстары жүктелуде.", delayed: "Іске қосу күткеннен ұзаққа созылды", delayedHelp: "Интерфейс модулі ескірген немесе қолжетімсіз болуы мүмкін. Сақталған қолданба деректері жойылған жоқ.", reload: "Бетті қайта жүктеу", refresh: "Қолданба файлдарын жаңарту", footnote: "Жаңарту тек SaltanatbotV2 offline shell файлдарын және оның service worker тіркеуін жояды." }
  };
  const saved = (() => { try { return localStorage.getItem("sbv2:locale"); } catch { return null; } })();
  const locale = ["en", "ru", "kk"].includes(saved) ? saved : navigator.language.toLowerCase().startsWith("kk") ? "kk" : navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
  const copy = copies[locale];
  const byId = (id) => document.getElementById(id);
  const hostname = location.hostname.toLowerCase();
  const localOrigin = hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  const canManageShell = (globalThis.isSecureContext === true || localOrigin) && ("serviceWorker" in navigator || "caches" in window);
  document.documentElement.lang = locale;
  byId("startup-title").textContent = copy.title;
  byId("startup-help").textContent = copy.help;
  byId("startup-reload").textContent = copy.reload;
  byId("startup-refresh").textContent = copy.refresh;
  byId("startup-footnote").textContent = copy.footnote;
  byId("startup-refresh").hidden = !canManageShell;
  byId("startup-footnote").hidden = !canManageShell;
  byId("startup-reload").addEventListener("click", () => location.reload());
  if (canManageShell) byId("startup-refresh").addEventListener("click", async () => {
    try {
      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.filter((registration) => [registration.active, registration.waiting, registration.installing].some((worker) => worker?.scriptURL.endsWith("/service-worker.js"))).map((registration) => registration.unregister()));
      }
      if ("caches" in window) {
        const names = await caches.keys();
        await Promise.all(names.filter((name) => name.startsWith("saltanat-shell-")).map((name) => caches.delete(name)));
      }
    } finally {
      location.reload();
    }
  });
  window.setTimeout(() => {
    const root = byId("startup-recovery");
    if (!root) return;
    root.setAttribute("role", "alert");
    byId("startup-title").textContent = copy.delayed;
    byId("startup-help").textContent = copy.delayedHelp;
    byId("startup-actions").hidden = false;
  }, 2_000);
})();
