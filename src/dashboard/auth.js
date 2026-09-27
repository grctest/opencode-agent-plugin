// Client-side recovery for the dashboard capability cookie.
//
// The server sets `loom_dashboard_<port>` on the HTML response and gates every
// /api/* route on it (server.js). A 401 means the cookie in this tab no longer
// matches the server's current token — e.g. the tab predates a server restart.
// A fresh page load fetches the HTML shell and its new cookie, so reloading
// once recovers without user action. The timestamp guard caps recovery at one
// reload per interval so a genuine auth failure surfaces as the normal error
// banner instead of looping forever.

const RELOAD_FLAG_KEY = "loom-dashboard-auth-reload";
const RELOAD_INTERVAL_MS = 30_000;

export function reloadForDashboardAuth() {
  try {
    const now = Date.now();
    const last = Number(sessionStorage.getItem(RELOAD_FLAG_KEY) ?? 0) || 0;
    if (now - last < RELOAD_INTERVAL_MS) return false;
    sessionStorage.setItem(RELOAD_FLAG_KEY, String(now));
    window.location.reload();
    return true;
  } catch {
    return false;
  }
}

export function clearDashboardAuthReload() {
  try { sessionStorage.removeItem(RELOAD_FLAG_KEY); } catch {}
}
