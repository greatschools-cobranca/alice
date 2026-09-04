/**
 * Torre de Controle — backend (Cloudflare Worker)
 *
 * Endpoints:
 *   POST /api/login            { username, password } -> sets session cookie
 *   POST /api/logout           -> clears session cookie
 *   GET  /api/session          -> { authenticated, username }
 *   GET  /api/routines         -> list of routines with current on/off state
 *   POST /api/routines/:id/toggle -> flips a routine's state, logs it, calls the
 *                                    bridge webhook if ROUTINE_WEBHOOK_URL is set
 *
 * Required secrets/vars (set with `wrangler secret put <NAME>`):
 *   JWT_SECRET          - random long string, signs the session cookie
 *   USERS_JSON          - JSON array: [{ "username": "renata", "passwordHash": "..." }, ...]
 *                         Generate a hash with the /gen-hash helper described in README.md.
 *   ROUTINE_WEBHOOK_URL - optional. If set, every toggle POSTs
 *                         { routineId, action: "enable"|"disable", by: username, at: ISO8601 }
 *                         to this URL. This is where OpenClaw (or whatever runs Alice)
 *                         should listen if/when it exposes a webhook trigger.
 *
 * Required binding:
 *   ROTINAS (KV namespace) - stores routine state and a short activity log.
 */

const COOKIE_NAME = "tc_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12h

const DEFAULT_ROUTINES = [
  {
    id: "agenda-cobranca",
    name: "Verificar planilha de eventos da Cobrança e atualizar agenda",
    schedule: "todos os dias · 08:00 (America/Sao_Paulo)",
    description:
      "Compara as planilhas de regras e de eventos com a agenda Google 'Cobrança'; cria/atualiza eventos e avisa cobranca@greatschools.com.br só quando algo muda.",
    defaultOn: true,
  },
  {
    id: "analise-base-cobranca",
    name: "Análise diária Base Cobrança por e-mail",
    schedule: "dias úteis · janelas entre 10:30 e 13:00 (America/Sao_Paulo)",
    description:
      "Procura o e-mail 'Base Cobrança - Análise diária' na caixa gmail-alice, classifica a base por CPF (Rematriculável / Mensagem automática) e responde com a planilha processada.",
    defaultOn: true,
  },
];

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers || {}),
    },
  });
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// ---- tiny helpers: hashing + HMAC session token (no external deps) ----

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, salt) {
  return sha256Hex(`${salt}:${password}`);
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function makeSessionToken(secret, username) {
  const payload = JSON.stringify({ u: username, exp: Date.now() + SESSION_TTL_SECONDS * 1000 });
  const b64 = btoa(payload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const sig = await hmac(secret, b64);
  return `${b64}.${sig}`;
}

async function verifySessionToken(secret, token) {
  if (!token) return null;
  const [b64, sig] = token.split(".");
  if (!b64 || !sig) return null;
  const expected = await hmac(secret, b64);
  if (expected !== sig) return null;
  try {
    const payload = JSON.parse(atob(b64.replace(/-/g, "+").replace(/_/g, "/")));
    if (payload.exp < Date.now()) return null;
    return payload.u;
  } catch {
    return null;
  }
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function requireAuth(request, env) {
  const token = getCookie(request, COOKIE_NAME);
  const username = await verifySessionToken(env.JWT_SECRET, token);
  return username; // null if not authenticated
}

async function getRoutineState(env) {
  const raw = await env.ROTINAS.get("state");
  const state = raw ? JSON.parse(raw) : {};
  return DEFAULT_ROUTINES.map((r) => ({
    ...r,
    on: Object.prototype.hasOwnProperty.call(state, r.id) ? state[r.id] : r.defaultOn,
  }));
}

async function setRoutineState(env, id, on) {
  const raw = await env.ROTINAS.get("state");
  const state = raw ? JSON.parse(raw) : {};
  state[id] = on;
  await env.ROTINAS.put("state", JSON.stringify(state));
}

async function appendLog(env, entry) {
  const raw = await env.ROTINAS.get("log");
  const log = raw ? JSON.parse(raw) : [];
  log.unshift(entry);
  await env.ROTINAS.put("log", JSON.stringify(log.slice(0, 200)));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    try {
      // ---- POST /api/login ----
      if (url.pathname === "/api/login" && request.method === "POST") {
        const { username, password } = await request.json();
        const users = JSON.parse(env.USERS_JSON || "[]");
        const user = users.find((u) => u.username === username);
        if (!user) return jsonResponse({ error: "Usuário ou senha inválidos." }, { status: 401, headers: cors });

        const [salt] = user.passwordHash.split("$");
        const computed = await hashPassword(password, salt);
        const fullComputed = `${salt}$${computed}`;
        if (fullComputed !== user.passwordHash) {
          return jsonResponse({ error: "Usuário ou senha inválidos." }, { status: 401, headers: cors });
        }

        const token = await makeSessionToken(env.JWT_SECRET, username);
        return jsonResponse(
          { ok: true, username },
          {
            headers: {
              ...cors,
              "Set-Cookie": `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${SESSION_TTL_SECONDS}`,
            },
          }
        );
      }

      // ---- POST /api/logout ----
      if (url.pathname === "/api/logout" && request.method === "POST") {
        return jsonResponse(
          { ok: true },
          {
            headers: {
              ...cors,
              "Set-Cookie": `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`,
            },
          }
        );
      }

      // ---- GET /api/session ----
      if (url.pathname === "/api/session" && request.method === "GET") {
        const username = await requireAuth(request, env);
        return jsonResponse({ authenticated: !!username, username: username || null }, { headers: cors });
      }

      // ---- GET /api/routines ----
      if (url.pathname === "/api/routines" && request.method === "GET") {
        const username = await requireAuth(request, env);
        if (!username) return jsonResponse({ error: "not authenticated" }, { status: 401, headers: cors });
        const routines = await getRoutineState(env);
        const rawLog = await env.ROTINAS.get("log");
        const log = rawLog ? JSON.parse(rawLog) : [];
        return jsonResponse({ routines, log: log.slice(0, 15) }, { headers: cors });
      }

      // ---- POST /api/routines/:id/toggle ----
      const toggleMatch = url.pathname.match(/^\/api\/routines\/([\w-]+)\/toggle$/);
      if (toggleMatch && request.method === "POST") {
        const username = await requireAuth(request, env);
        if (!username) return jsonResponse({ error: "not authenticated" }, { status: 401, headers: cors });

        const id = toggleMatch[1];
        const routine = DEFAULT_ROUTINES.find((r) => r.id === id);
        if (!routine) return jsonResponse({ error: "rotina não encontrada" }, { status: 404, headers: cors });

        const current = await getRoutineState(env);
        const currentlyOn = current.find((r) => r.id === id).on;
        const nextOn = !currentlyOn;
        await setRoutineState(env, id, nextOn);

        const logEntry = {
          routineId: id,
          routineName: routine.name,
          action: nextOn ? "enable" : "disable",
          by: username,
          at: new Date().toISOString(),
          bridged: false,
        };

        // If a bridge webhook is configured (e.g. an OpenClaw HTTP trigger),
        // forward the toggle so it can actually pause/resume Alice's routine.
        if (env.ROUTINE_WEBHOOK_URL) {
          try {
            await fetch(env.ROUTINE_WEBHOOK_URL, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                routineId: id,
                routineName: routine.name,
                action: nextOn ? "enable" : "disable",
                by: username,
                at: logEntry.at,
              }),
            });
            logEntry.bridged = true;
          } catch (err) {
            logEntry.bridgeError = String(err);
          }
        }

        await appendLog(env, logEntry);
        return jsonResponse({ ok: true, id, on: nextOn, bridged: logEntry.bridged }, { headers: cors });
      }

      return jsonResponse({ error: "not found" }, { status: 404, headers: cors });
    } catch (err) {
      return jsonResponse({ error: String(err) }, { status: 500, headers: cors });
    }
  },
};
