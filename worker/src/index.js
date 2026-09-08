/**
 * Torre de Controle — backend (Cloudflare Worker)
 *
 * Endpoints:
 *   POST /api/login            { username, password } -> sets session cookie
 *   POST /api/logout           -> clears session cookie
 *   GET  /api/session          -> { authenticated, username }
 *   GET  /api/routines         -> list of routines with current on/off state
 *   GET  /api/routines/status  -> PUBLIC, no auth. Minimal machine-readable status:
 *                                  [{ id, on }, ...]. Meant for Alice/OpenClaw to poll
 *                                  before running a routine — no names/descriptions/logs.
 *   POST /api/routines/:id/toggle -> flips a routine's state, logs it, calls the
 *                                    bridge webhook if ROUTINE_WEBHOOK_URL is set
 *
 *   POST /api/agent/routines       -> Alice proposes a brand-new routine. Requires the
 *                                      X-Agent-Key header (ALICE_API_KEY). Goes into a
 *                                      pending queue — nothing shows up on the Torre or
 *                                      counts toward anything until Renata approves it.
 *   POST /api/agent/routines/:id   -> Alice proposes an edit to a routine SHE created
 *                                      before (not the two built-in ones). Same auth,
 *                                      same pending-approval flow.
 *   GET  /api/routines/pending             -> (Renata, authenticated) list of pending
 *                                              proposals waiting for approval.
 *   POST /api/routines/pending/:id/approve -> (Renata) applies a pending proposal.
 *   POST /api/routines/pending/:id/reject  -> (Renata) discards a pending proposal.
 *
 * Required secrets/vars (set with `wrangler secret put <NAME>`):
 *   JWT_SECRET          - random long string, signs the session cookie
 *   USERS_JSON          - JSON array: [{ "username": "renata", "passwordHash": "..." }, ...]
 *                         Generate a hash with the /gen-hash helper described in README.md.
 *   ROUTINE_WEBHOOK_URL - optional. If set, every toggle POSTs
 *                         { routineId, action: "enable"|"disable", by: username, at: ISO8601 }
 *                         to this URL. This is where OpenClaw (or whatever runs Alice)
 *                         should listen if/when it exposes a webhook trigger.
 *   ALICE_API_KEY       - random long string. Alice/OpenClaw sends it as the
 *                         "X-Agent-Key" header on every /api/agent/* call. Without this
 *                         secret set, the agent endpoints are disabled (401).
 *
 * Required binding:
 *   ROTINAS (KV namespace) - stores routine state, custom routines created via the
 *                             agent endpoints, the pending-approval queue, and a short
 *                             activity log.
 */

const COOKIE_NAME = "tc_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12h

const DEFAULT_ROUTINES = [
  {
    id: "agenda-cobranca",
    name: "Atualizar cronograma de disparos da régua automática de cobrança",
    note: "Realizado diretamente na Planilha Online de Cronograma.",
    schedule: "todos os dias · 08:00 (America/Sao_Paulo)",
    description:
      "Essa rotina atualiza a base de disparos automáticos da integração TOTVS x WorkChat para o período informado na aba Disparos TOTVS. A finalidade é calcular, por unidade/escola, quantos disparos de cada régua de cobrança serão realizados na semana.",
    steps: [
      {
        title: "Verificar o arquivo de origem no Drive",
        items: [
          "Acessar a pasta BOLETOS POR DIA DE VENCIMENTO.",
          "Confirmar que o arquivo do dia existe na pasta.",
          "Validar a estrutura mínima: Grupo, Unidade, DATA VENCIMENTO, QT. BOLETOS e QT. BOLETOS INA.",
        ],
      },
      {
        title: "Atualizar o período de disparo",
        items: [
          "Abrir a planilha Cronograma Cobrança - 2026.",
          "Ir na aba Disparos TOTVS.",
          "Ajustar o período de disparo com segunda e sexta-feira da semana atual.",
        ],
      },
      {
        title: "Limpar os resultados antigos",
        items: [
          "Limpar os resultados da tabela da aba Disparos TOTVS.",
          "Limpar os resultados da aba Tabela vencimentos.",
        ],
      },
      {
        title: "Atualizar a Tabela vencimentos",
        items: [
          "Usar o arquivo BOLETOS POR DIA DE VENCIMENTO como origem.",
          "Atualizar os vencimentos do mês anterior e do mês atual com QT. BOLETOS INA maior que zero.",
          "Atualizar também os vencimentos do mês atual, a partir do dia de hoje, com QT. BOLETOS maior que zero.",
          "Manter uma linha por unidade/escola.",
          "Atualizar a observação com data e \"Atualizado por: Alice Fontes\".",
        ],
      },
      {
        title: "Apresentar os resultados na Disparos TOTVS",
        items: [
          "Usar a Tabela consulta-Não editar para identificar as datas de disparo por régua.",
          "Apresentar uma linha para cada unidade/escola.",
          "Não agrupar unidades na mesma linha.",
          "Considerar apenas disparos dentro do período configurado.",
        ],
      },
      {
        title: "Conferência final",
        items: [
          "Validar o período configurado.",
          "Validar que a aba Disparos TOTVS não tem registros antigos de resultado.",
          "Somar o total de disparos e conferir se o volume faz sentido.",
        ],
      },
    ],
    defaultOn: true,
  },
  {
    id: "analise-base-cobranca",
    name: "Suporte na preparação da base de cobrança manual",
    note: "Sob demanda / Solicitação recebida por email.",
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
    "Access-Control-Allow-Headers": "Content-Type, X-Agent-Key",
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

function requireAgentAuth(request, env) {
  if (!env.ALICE_API_KEY) return false;
  const header = request.headers.get("X-Agent-Key") || "";
  return header === env.ALICE_API_KEY;
}

function isValidSlug(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9-]{1,49}$/.test(id);
}

function newProposalId() {
  return `prop-${crypto.randomUUID().slice(0, 8)}`;
}

// ---- KV-backed collections ----

async function getCustomRoutines(env) {
  const raw = await env.ROTINAS.get("custom_routines");
  return raw ? JSON.parse(raw) : {};
}

async function setCustomRoutines(env, map) {
  await env.ROTINAS.put("custom_routines", JSON.stringify(map));
}

async function getPendingProposals(env) {
  const raw = await env.ROTINAS.get("pending_proposals");
  return raw ? JSON.parse(raw) : [];
}

async function setPendingProposals(env, list) {
  await env.ROTINAS.put("pending_proposals", JSON.stringify(list));
}

async function getAllRoutineDefs(env) {
  const custom = await getCustomRoutines(env);
  return [...DEFAULT_ROUTINES, ...Object.values(custom)];
}

async function getRoutineState(env) {
  const raw = await env.ROTINAS.get("state");
  const state = raw ? JSON.parse(raw) : {};
  const all = await getAllRoutineDefs(env);
  return all.map((r) => ({
    ...r,
    on: Object.prototype.hasOwnProperty.call(state, r.id) ? state[r.id] : !!r.defaultOn,
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

      // ---- GET /api/routines/status (public, no auth, minimal fields) ----
      if (url.pathname === "/api/routines/status" && request.method === "GET") {
        const routines = await getRoutineState(env);
        const status = routines.map((r) => ({ id: r.id, on: r.on }));
        return jsonResponse(status, { headers: cors });
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
        const all = await getAllRoutineDefs(env);
        const routine = all.find((r) => r.id === id);
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

      // ---- POST /api/agent/routines (Alice proposes a NEW routine) ----
      if (url.pathname === "/api/agent/routines" && request.method === "POST") {
        if (!requireAgentAuth(request, env)) {
          return jsonResponse({ error: "chave de agente inválida ou ausente" }, { status: 401, headers: cors });
        }
        const body = await request.json().catch(() => null);
        if (!body) return jsonResponse({ error: "corpo JSON inválido" }, { status: 400, headers: cors });
        const { id, name, schedule, description, note, steps, defaultOn } = body;

        if (!isValidSlug(id)) {
          return jsonResponse(
            { error: "id inválido — use letras minúsculas, números e hífen (ex: revisar-boletos-atraso)" },
            { status: 400, headers: cors }
          );
        }
        if (!name || !schedule || !description) {
          return jsonResponse({ error: "faltam campos obrigatórios: name, schedule, description" }, { status: 400, headers: cors });
        }
        if (steps !== undefined && !Array.isArray(steps)) {
          return jsonResponse({ error: "steps, se enviado, precisa ser uma lista de { title, items[] }" }, { status: 400, headers: cors });
        }

        const all = await getAllRoutineDefs(env);
        if (all.some((r) => r.id === id)) {
          return jsonResponse(
            { error: "já existe uma rotina com esse id — para alterá-la use POST /api/agent/routines/" + id },
            { status: 409, headers: cors }
          );
        }
        const pending = await getPendingProposals(env);
        if (pending.some((p) => p.type === "create" && p.routineId === id)) {
          return jsonResponse({ error: "já existe uma proposta pendente com esse id" }, { status: 409, headers: cors });
        }

        const proposal = {
          proposalId: newProposalId(),
          type: "create",
          routineId: id,
          payload: {
            id,
            name,
            schedule,
            description,
            note: note || "",
            ...(Array.isArray(steps) ? { steps } : {}),
            defaultOn: !!defaultOn,
          },
          proposedBy: "alice",
          proposedAt: new Date().toISOString(),
        };
        pending.unshift(proposal);
        await setPendingProposals(env, pending);
        await appendLog(env, {
          routineId: id,
          routineName: name,
          action: "propose_create",
          by: "alice",
          at: proposal.proposedAt,
        });
        return jsonResponse({ ok: true, proposalId: proposal.proposalId, status: "pending_approval" }, { status: 201, headers: cors });
      }

      // ---- POST /api/agent/routines/:id (Alice proposes an EDIT to a routine she created) ----
      const agentEditMatch = url.pathname.match(/^\/api\/agent\/routines\/([\w-]+)$/);
      if (agentEditMatch && request.method === "POST") {
        if (!requireAgentAuth(request, env)) {
          return jsonResponse({ error: "chave de agente inválida ou ausente" }, { status: 401, headers: cors });
        }
        const routineId = agentEditMatch[1];
        const custom = await getCustomRoutines(env);
        const current = custom[routineId];
        if (!current) {
          return jsonResponse(
            { error: "só é possível editar rotinas criadas pela Alice e já aprovadas por Renata" },
            { status: 404, headers: cors }
          );
        }

        const body = await request.json().catch(() => null);
        if (!body) return jsonResponse({ error: "corpo JSON inválido" }, { status: 400, headers: cors });

        const allowedFields = ["name", "schedule", "description", "note", "steps", "defaultOn"];
        const changes = {};
        for (const key of allowedFields) {
          if (Object.prototype.hasOwnProperty.call(body, key)) changes[key] = body[key];
        }
        if (changes.steps !== undefined && !Array.isArray(changes.steps)) {
          return jsonResponse({ error: "steps, se enviado, precisa ser uma lista de { title, items[] }" }, { status: 400, headers: cors });
        }
        if (Object.keys(changes).length === 0) {
          return jsonResponse({ error: "nenhum campo reconhecido foi enviado para alterar" }, { status: 400, headers: cors });
        }

        const pending = await getPendingProposals(env);
        const proposal = {
          proposalId: newProposalId(),
          type: "edit",
          routineId,
          payload: changes,
          proposedBy: "alice",
          proposedAt: new Date().toISOString(),
        };
        pending.unshift(proposal);
        await setPendingProposals(env, pending);
        await appendLog(env, {
          routineId,
          routineName: current.name,
          action: "propose_edit",
          by: "alice",
          at: proposal.proposedAt,
        });
        return jsonResponse({ ok: true, proposalId: proposal.proposalId, status: "pending_approval" }, { status: 201, headers: cors });
      }

      // ---- GET /api/routines/pending (Renata, authenticated) ----
      if (url.pathname === "/api/routines/pending" && request.method === "GET") {
        const username = await requireAuth(request, env);
        if (!username) return jsonResponse({ error: "not authenticated" }, { status: 401, headers: cors });
        const pending = await getPendingProposals(env);
        const custom = await getCustomRoutines(env);
        const enriched = pending.map((p) => ({
          ...p,
          current: p.type === "edit" ? custom[p.routineId] || null : null,
        }));
        return jsonResponse({ pending: enriched }, { headers: cors });
      }

      // ---- POST /api/routines/pending/:proposalId/approve ----
      const approveMatch = url.pathname.match(/^\/api\/routines\/pending\/([\w-]+)\/approve$/);
      if (approveMatch && request.method === "POST") {
        const username = await requireAuth(request, env);
        if (!username) return jsonResponse({ error: "not authenticated" }, { status: 401, headers: cors });

        const proposalId = approveMatch[1];
        const pending = await getPendingProposals(env);
        const idx = pending.findIndex((p) => p.proposalId === proposalId);
        if (idx === -1) return jsonResponse({ error: "proposta não encontrada" }, { status: 404, headers: cors });

        const proposal = pending[idx];
        const custom = await getCustomRoutines(env);

        if (proposal.type === "create") {
          custom[proposal.routineId] = {
            ...proposal.payload,
            createdBy: "alice",
            createdAt: proposal.proposedAt,
            approvedBy: username,
            approvedAt: new Date().toISOString(),
          };
          if (proposal.payload.defaultOn) {
            await setRoutineState(env, proposal.routineId, true);
          }
        } else if (proposal.type === "edit") {
          const existing = custom[proposal.routineId];
          if (!existing) {
            return jsonResponse({ error: "a rotina original não existe mais" }, { status: 404, headers: cors });
          }
          custom[proposal.routineId] = {
            ...existing,
            ...proposal.payload,
            updatedBy: username,
            updatedAt: new Date().toISOString(),
          };
        }

        await setCustomRoutines(env, custom);
        pending.splice(idx, 1);
        await setPendingProposals(env, pending);
        await appendLog(env, {
          routineId: proposal.routineId,
          routineName: custom[proposal.routineId]?.name || proposal.routineId,
          action: proposal.type === "create" ? "approve_create" : "approve_edit",
          by: username,
          at: new Date().toISOString(),
        });
        return jsonResponse({ ok: true }, { headers: cors });
      }

      // ---- POST /api/routines/pending/:proposalId/reject ----
      const rejectMatch = url.pathname.match(/^\/api\/routines\/pending\/([\w-]+)\/reject$/);
      if (rejectMatch && request.method === "POST") {
        const username = await requireAuth(request, env);
        if (!username) return jsonResponse({ error: "not authenticated" }, { status: 401, headers: cors });

        const proposalId = rejectMatch[1];
        const pending = await getPendingProposals(env);
        const idx = pending.findIndex((p) => p.proposalId === proposalId);
        if (idx === -1) return jsonResponse({ error: "proposta não encontrada" }, { status: 404, headers: cors });

        const proposal = pending[idx];
        pending.splice(idx, 1);
        await setPendingProposals(env, pending);
        await appendLog(env, {
          routineId: proposal.routineId,
          routineName: proposal.payload?.name || proposal.routineId,
          action: proposal.type === "create" ? "reject_create" : "reject_edit",
          by: username,
          at: new Date().toISOString(),
        });
        return jsonResponse({ ok: true }, { headers: cors });
      }

      return jsonResponse({ error: "not found" }, { status: 404, headers: cors });
    } catch (err) {
      return jsonResponse({ error: String(err) }, { status: 500, headers: cors });
    }
  },
};
