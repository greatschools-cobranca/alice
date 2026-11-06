// Login com Google: valida o "ID token" emitido pelo Google e aplica a lista de e-mails autorizados.
//
// Configuração (GitHub Secrets → Worker):
//   GOOGLE_CLIENT_ID      ID do cliente OAuth (tipo "Aplicativo da Web") do Google Cloud
//   ALLOWED_EMAILS        e-mails autorizados, separados por vírgula
//   ALLOWED_DOMAIN        (var) domínio obrigatório; padrão greatschools.com.br
//   ALLOW_PASSWORD_LOGIN  "true" reabre o login por senha (emergência). Sem GOOGLE_CLIENT_ID, a senha segue valendo.
import { HttpError } from "./util.js";

const ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const SKEW_S = 60;
let jwksCache = null; // { keys, exp }

export function googleConfigured(env) {
  return !!env.GOOGLE_CLIENT_ID;
}

/** Login por código no e-mail: precisa da lista de autorizados e do envio de e-mail (Apps Script). */
export function emailCodeConfigured(env) {
  return allowedEmails(env).length > 0 && !!(env.MAIL_WEBHOOK_URL && env.MAIL_WEBHOOK_SECRET);
}

/** A senha só vale enquanto nenhum login forte (Google ou código) estiver configurado, ou em emergência. */
export function passwordLoginEnabled(env) {
  return (!googleConfigured(env) && !emailCodeConfigured(env)) || env.ALLOW_PASSWORD_LOGIN === "true";
}

export function allowedDomain(env) {
  return (env.ALLOWED_DOMAIN || "greatschools.com.br").toLowerCase();
}

export function allowedEmails(env) {
  return String(env.ALLOWED_EMAILS || "")
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Administradoras: podem incluir, editar, excluir e importar rotinas e aprovar propostas. */
export function adminEmails(env) {
  return String(env.ADMIN_EMAILS || "").split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
}
export function isAdmin(env, user) {
  const list = adminEmails(env);
  if (!list.length) return true; // transição: sem ADMIN_EMAILS cadastrado, todos seguem podendo (comportamento anterior)
  return list.includes(String(user || "").toLowerCase());
}

/** E-mail do domínio da empresa e presente na lista. */
export function emailAuthorized(env, email) {
  const e = String(email || "").toLowerCase();
  return e.endsWith("@" + allowedDomain(env)) && allowedEmails(env).includes(e);
}

function b64urlToBytes(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function googleKeys(env, force = false) {
  if (!force && jwksCache && jwksCache.exp > Date.now()) return jwksCache.keys;
  const res = await fetch(env.GOOGLE_JWKS_URL || JWKS_URL, { cf: { cacheTtl: 3600 } });
  if (!res.ok) throw new HttpError(503, "não consegui falar com o Google agora; tente de novo");
  const { keys } = await res.json();
  jwksCache = { keys, exp: Date.now() + 60 * 60 * 1000 };
  return keys;
}

/**
 * Valida o ID token do Google. Devolve { email, name } ou lança HttpError(401/403).
 * Confere: assinatura RS256 com as chaves públicas do Google, emissor, público (client id),
 * validade, e-mail verificado, domínio (hd) e lista de autorizados.
 */
export async function verifyGoogleIdToken(env, idToken) {
  if (!googleConfigured(env)) throw new HttpError(503, "login com Google ainda não configurado");
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new HttpError(401, "credencial do Google inválida");
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch {
    throw new HttpError(401, "credencial do Google inválida");
  }
  if (header.alg !== "RS256" || !header.kid) throw new HttpError(401, "credencial do Google inválida");

  let jwk = (await googleKeys(env)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(env, true)).find((k) => k.kid === header.kid); // chaves do Google giram
  if (!jwk) throw new HttpError(401, "credencial do Google inválida");
  const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) throw new HttpError(401, "credencial do Google inválida");

  const now = Math.floor(Date.now() / 1000);
  if (!ISSUERS.includes(payload.iss)) throw new HttpError(401, "credencial do Google inválida");
  if (payload.aud !== env.GOOGLE_CLIENT_ID) throw new HttpError(401, "credencial do Google inválida");
  if (typeof payload.exp !== "number" || payload.exp + SKEW_S < now) throw new HttpError(401, "a credencial do Google expirou; entre de novo");
  if (typeof payload.iat === "number" && payload.iat - SKEW_S > now) throw new HttpError(401, "credencial do Google inválida");
  if (payload.email_verified !== true) throw new HttpError(403, "o e-mail da conta Google não está verificado");

  const email = String(payload.email || "").toLowerCase();
  const domain = allowedDomain(env);
  if (payload.hd !== domain || !email.endsWith("@" + domain)) {
    throw new HttpError(403, `acesso permitido só com conta @${domain}`);
  }
  if (!allowedEmails(env).includes(email)) {
    const err = new HttpError(403, "este e-mail não está autorizado a acessar a Torre; peça acesso à responsável");
    err.denied = email;
    throw err;
  }
  return { email, name: payload.given_name || payload.name || email.split("@")[0] };
}
