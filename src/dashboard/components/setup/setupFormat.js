export function formatContext(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  return n >= 1000 ? `${Math.round(n / 1000)}k ctx` : `${n} ctx`;
}

export function formatCost(cost) {
  if (!cost || (cost.input === 0 && cost.output === 0)) return "free";
  return `$${cost.input}/$${cost.output}`;
}

export async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `Request failed (HTTP ${res.status})`);
  return data;
}

export const MODEL_ROW_HEIGHT = 40;
