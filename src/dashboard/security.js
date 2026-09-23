function hostNameOnly(host) {
  const value = String(host ?? "").trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end >= 0 ? value.slice(1, end) : value;
  }
  const colon = value.lastIndexOf(":");
  return colon > 0 ? value.slice(0, colon) : value;
}

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function isAllowedDashboardHost(hostHeader, configuredHostname) {
  const host = hostNameOnly(hostHeader);
  if (!host) return false;
  if (isLoopbackHost(configuredHostname)) return isLoopbackHost(host);
  return true;
}

export function hasDashboardCapability(headers, token, cookieName) {
  const headerToken = headers.get("x-loom-dashboard-token");
  if (headerToken && headerToken === token) return true;
  const cookie = headers.get("cookie") ?? "";
  const escapedName = String(cookieName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${escapedName}=([^;]+)`));
  return !!match && match[1] === token;
}

export function isSameOriginRequest(headers, url) {
  if (headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = headers.get("origin");
  return !origin || origin === url.origin;
}
