// Login, sessão (token assinado com HMAC) e autenticação da Alice.
import { HttpError, safeEqual, randomHex } from "./util.js";
import { emailAuthorized, passwordLoginEnabled } from "./google.js";

export const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12h
const PBKDF2_ITERATIONS = 20000; // limitado pelo orçamento de CPU do plano gratuito do Workers
const MAX_FAILS = 5;
const LOCK_SECONDS = 15 * 60;

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecodeToString(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function requireSecret(env) {
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 16) {
    throw new HttpError(500, "configuração incompleta: JWT_SECRET ausente ou curto demais");
  }
  return env.JWT_SECRET;
}

export async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64url(new Uint8Array(sig));
}

async function pbkdf2Hex(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations },
    key,
    256
  );
  return hex(bits);
}

export async function makePasswordHash(password) {
  const salt = randomHex(16);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${await pbkdf2Hex(password, salt, PBKDF2_ITERATIONS)}`;
}

/** Aceita o formato novo (pbkdf2$iter$salt$hash) e o antigo (salt$sha256). */
async function verifyPassword(password, stored) {
  if (typeof stored !== "string") return { ok: false };
  const parts = stored.split("$");
  if (parts[0] === "pbkdf2" && parts.length === 4) {
    const computed = await pbkdf2Hex(password, parts[2], Number(parts[1]));
    return { ok: safeEqual(computed, parts[3]), legacy: false };
  }
  if (parts.length === 2) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${parts[0]}:${password}`));
    return { ok: safeEqual(hex(digest), parts[1]), legacy: true };
  }
  return { ok: false };
}

function users(env) {
  try {
    return JSON.parse(env.USERS_JSON || "[]");
  } catch {
    throw new HttpError(500, "configuração incompleta: USERS_JSON inválido");
  }
}

/** via: "google" ou "senha". Sessões por senha só valem enquanto o login por senha estiver liberado. */
export async function makeSessionToken(env, username, via = "senha") {
  const secret = requireSecret(env);
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ u: username, v: via, exp: Date.now() + SESSION_TTL_SECONDS * 1000 })));
  return `${payload}.${await hmac(secret, "session:" + payload)}`;
}

async function verifySessionToken(env, token) {
  if (!token) return null;
  const secret = requireSecret(env);
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if (!safeEqual(await hmac(secret, "session:" + payload), sig)) return null;
  try {
    const data = JSON.parse(b64urlDecodeToString(payload));
    if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
    if (data.v === "google") {
      // e-mail retirado da lista perde o acesso na hora
      return emailAuthorized(env, data.u) ? data.u : null;
    }
    if (!passwordLoginEnabled(env)) return null; // com Google ativo, sessões antigas por senha deixam de valer
    if (!users(env).some((u) => u.username === data.u)) return null; // usuário removido perde acesso
    return data.u;
  } catch {
    return null;
  }
}

/** Retorna o usuário logado ou lança 401. */
export async function requireUser(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const username = await verifySessionToken(env, token);
  if (!username) throw new HttpError(401, "sessão expirada ou inválida — entre de novo");
  return username;
}

export function requireAgent(request, env) {
  const header = request.headers.get("X-Agent-Key") || "";
  if (!env.ALICE_API_KEY || !safeEqual(header, env.ALICE_API_KEY)) {
    throw new HttpError(401, "chave de agente inválida ou ausente");
  }
  return "alice";
}

// A chave da ponte não permite propor rotinas, baixar arquivos nem operar o agente.
export function requireBridge(request, env) {
  const value = request.headers.get("X-Bridge-Key") || "";
  if (!env.BRIDGE_API_KEY || !safeEqual(value, env.BRIDGE_API_KEY)) throw new HttpError(401, "chave da ponte inválida ou ausente");
  return "ponte";
}

/**
 * Valida usuário e senha com limite de tentativas.
 * Retorna { username, locked?: true } ou lança HttpError.
 * Hashes no formato antigo são atualizados para PBKDF2 no KV no primeiro login bem-sucedido.
 */
export async function login(env, username, password, onLock) {
  if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
    throw new HttpError(400, "informe usuário e senha");
  }
  const rlKey = `rl:${username.toLowerCase()}`;
  const fails = Number((await env.ROTINAS.get(rlKey)) || 0);
  if (fails >= MAX_FAILS) {
    throw new HttpError(429, "muitas tentativas — aguarde 15 minutos e tente de novo");
  }

  const user = users(env).find((u) => u.username === username);
  // Hash atualizado só vale enquanto o USERS_JSON não mudar a senha dessa pessoa.
  const upgradedRaw = user ? await env.ROTINAS.get(`user_hash:${username}`, "json") : null;
  const upgraded = upgradedRaw && upgradedRaw.from === user.passwordHash ? upgradedRaw.hash : null;
  const result = user ? await verifyPassword(password, upgraded || user.passwordHash) : { ok: false };

  if (!result.ok) {
    const next = fails + 1;
    await env.ROTINAS.put(rlKey, String(next), { expirationTtl: LOCK_SECONDS });
    if (next >= MAX_FAILS && onLock) await onLock(username);
    throw new HttpError(401, "usuário ou senha inválidos");
  }

  await env.ROTINAS.delete(rlKey);
  if (result.legacy && !upgraded) {
    await env.ROTINAS.put(
      `user_hash:${username}`,
      JSON.stringify({ from: user.passwordHash, hash: await makePasswordHash(password) })
    );
  }
  return username;
}
