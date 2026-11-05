// Utilitários compartilhados: respostas JSON, CORS, ids, comparação segura e datas em SP.

export const TZ = "America/Sao_Paulo";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(data, status = 200, headers = {}) {
  const output = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  for (const [key, value] of Object.entries(headers)) output.set(key, value);
  return new Response(JSON.stringify(data), {
    status,
    headers: output,
  });
}

/** Origens liberadas para o navegador chamar a API (lista separada por vírgula). */
export function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || "https://greatschools-cobranca.github.io")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins(env).includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-File-Name",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export function withHeaders(response, headers) {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(headers)) r.headers.set(k, v);
  return r;
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "corpo JSON inválido");
  }
}

/** Comparação em tempo constante (evita descobrir segredos pelo tempo de resposta). */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const len = Math.max(ea.length, eb.length);
  for (let i = 0; i < len; i++) diff |= (ea[i] || 0) ^ (eb[i] || 0);
  return diff === 0;
}

export function randomHex(bytes = 8) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Timestamp invertido: chaves mais novas aparecem primeiro na listagem do KV. */
export function invTs(ms = Date.now()) {
  return String(9999999999999 - ms).padStart(13, "0");
}

export function isValidSlug(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9-]{1,49}$/.test(id);
}

/** Partes da data/hora atual em São Paulo. weekday: 1=segunda ... 7=domingo. */
export function spNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
    weekday: wd,
  };
}

export function spDate(iso) {
  return spNow(new Date(iso)).date;
}

export function fmtSp(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { timeZone: TZ });
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function clip(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
