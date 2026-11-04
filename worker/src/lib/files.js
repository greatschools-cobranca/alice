// Arquivos anexados (pela Torre ou pela Alice). Ficam no KV por 7 dias.
// O download usa link assinado e com validade, então a Alice baixa com um simples `curl -L`.
import { HttpError, randomHex, safeEqual, clip } from "./util.js";
import { hmac } from "./auth.js";

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // KV aceita até 25 MiB por valor
const FILE_TTL_SECONDS = 60 * 60 * 24 * 7;

/** Recebe o arquivo cru no corpo da requisição (sem multipart, para gastar pouca CPU). */
export async function storeUpload(request, env, uploadedBy) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (!len) throw new HttpError(411, "envie o arquivo com Content-Length");
  if (len > MAX_FILE_BYTES) throw new HttpError(413, "arquivo maior que 20 MB");
  let name = "arquivo";
  try {
    name = decodeURIComponent(request.headers.get("X-File-Name") || "arquivo");
  } catch {
    /* mantém o padrão */
  }
  name = clip(name.replace(/[\\/\r\n"]/g, "_"), 150) || "arquivo";
  const type = clip(request.headers.get("Content-Type") || "application/octet-stream", 100);
  const id = `f${Date.now().toString(36)}${randomHex(6)}`;
  const meta = { name, type, size: len, uploadedBy, at: new Date().toISOString() };
  await env.ROTINAS.put(`file:${id}`, request.body, { metadata: meta, expirationTtl: FILE_TTL_SECONDS });
  return { id, ...meta };
}

export async function fileInfo(env, id) {
  if (!/^f[0-9a-z]+$/.test(id)) return null;
  const { value, metadata } = await env.ROTINAS.getWithMetadata(`file:${id}`, "stream");
  if (!value) return null;
  value.cancel?.();
  return { id, ...metadata };
}

async function signature(env, id, exp) {
  return hmac(env.JWT_SECRET, `file:${id}.${exp}`);
}

/** Link de download válido por `hours` horas. */
export async function signedFileUrl(env, apiBase, id, hours = 72) {
  const exp = Math.floor(Date.now() / 1000) + hours * 3600;
  return `${apiBase}/api/files/${id}?exp=${exp}&sig=${await signature(env, id, exp)}`;
}

export async function serveSignedFile(env, id, url) {
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") || "";
  if (!exp || exp < Date.now() / 1000) throw new HttpError(403, "link expirado");
  if (!safeEqual(await signature(env, id, exp), sig)) throw new HttpError(403, "link inválido");
  if (!/^f[0-9a-z]+$/.test(id)) throw new HttpError(404, "arquivo não encontrado");
  const { value, metadata } = await env.ROTINAS.getWithMetadata(`file:${id}`, "stream");
  if (!value) throw new HttpError(404, "arquivo não encontrado ou expirado");
  const filename = encodeURIComponent(metadata?.name || "arquivo");
  return new Response(value, {
    headers: {
      "content-type": metadata?.type || "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${filename}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Valida uma lista de ids de arquivo e devolve [{id,name,size,type,url}]. */
export async function resolveFiles(env, apiBase, ids, hours = 72) {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.length > 10) throw new HttpError(400, "files precisa ser uma lista de até 10 ids");
  const out = [];
  for (const id of ids) {
    const info = await fileInfo(env, String(id));
    if (!info) throw new HttpError(400, `arquivo ${id} não encontrado ou expirado`);
    out.push({ id: info.id, name: info.name, size: info.size, type: info.type, url: await signedFileUrl(env, apiBase, info.id, hours) });
  }
  return out;
}

export function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
