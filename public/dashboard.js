(function initDashboardRedirect() {
    if (window.DailyHubI18n && typeof window.DailyHubI18n.applyTranslations === 'function') {
        var lang = window.DailyHubI18n.getLang();
        document.documentElement.lang = lang;
        document.title = lang === 'es'
            ? 'Resumen Semanal - Daily Hub'
            : 'Weekly Summary - Daily Hub';
        window.DailyHubI18n.applyTranslations(document.body || document.documentElement);
    }
    try {
        window.location.replace('index.html#resumen');
    } catch (_) {}
})();
