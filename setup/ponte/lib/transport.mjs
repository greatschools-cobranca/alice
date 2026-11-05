// Nenhum redirect é seguido com uma credencial. Host e caminho vêm da instalação.
export function transport(origin, key, fetcher = fetch) {
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error("invalid_torre_origin");
  return async (path, method = "GET", body) => {
    if (!/^\/(status|control|heartbeat|next|jobs\/r[0-9a-f]{32}\/result)$/.test(path)) throw new Error("invalid_api_path");
    const r = await fetcher(new URL("/api/bridge/v2" + path, base), {
      method, redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { "X-Bridge-Key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(r.status === 401 ? "torre_auth" : r.status === 404 || r.status === 410 ? "torre_protocol_not_published" : "torre_http");
    if (!/\bapplication\/json\b/i.test(r.headers.get("content-type") || "")) throw new Error("torre_invalid_json");
    const len = Number(r.headers.get("content-length"));
    if (len > 256000) throw new Error("torre_response_size");
    const reader = r.body.getReader(); let size = 0; const chunks = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 256000) { await reader.cancel(); throw new Error("torre_response_size"); } chunks.push(value); }
    let value; try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("torre_invalid_json"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("torre_invalid_json");
    return value;
  };
}
