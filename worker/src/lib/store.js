// Acesso ao KV: rotinas (definições ficam só no KV, não no código), estado liga/desliga,
// propostas da Alice, últimas execuções e tarefas.
import { HttpError, isValidSlug, invTs, randomHex, clip } from "./util.js";
import { fila } from "./fila.js";

// ---------- validação de rotina ----------

function str(v, field, max, required = false) {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `campo obrigatório: ${field}`);
    return "";
  }
  if (typeof v !== "string") throw new HttpError(400, `${field} precisa ser texto`);
  if (v.length > max) throw new HttpError(400, `${field} passa de ${max} caracteres`);
  return v;
}

function steps(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 40) throw new HttpError(400, "steps precisa ser uma lista de { title, items[] } (até 40)");
  return v.map((s, i) => {
    if (!s || typeof s.title !== "string" || !Array.isArray(s.items)) {
      throw new HttpError(400, `steps[${i}] precisa ter title e items[]`);
    }
    return { title: clip(s.title, 200), items: s.items.slice(0, 60).map((it) => clip(String(it), 1000)) };
  });
}

function checks(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 10) throw new HttpError(400, "checks precisa ser uma lista (até 10)");
  return v.map((c, i) => {
    const days = Array.isArray(c?.days) ? [...new Set(c.days.map(Number))].filter((d) => d >= 1 && d <= 7).sort() : [];
    if (!days.length) throw new HttpError(400, `checks[${i}].days precisa ter dias de 1 (segunda) a 7 (domingo)`);
    if (typeof c.by !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(c.by)) {
      throw new HttpError(400, `checks[${i}].by precisa ser HH:MM`);
    }
    return { days, by: c.by };
  });
}

/** Normaliza os campos editáveis de uma rotina. `partial` aceita só os campos enviados. */
export function sanitizeRoutineFields(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (!partial || has("name")) out.name = str(body.name, "name", 200, true);
  if (!partial || has("schedule")) out.schedule = str(body.schedule, "schedule", 300, true);
  if (!partial || has("description")) out.description = str(body.description, "description", 5000, true);
  if (!partial || has("note")) out.note = str(body.note, "note", 500);
  if (!partial || has("prompt")) out.prompt = str(body.prompt, "prompt", 20000);
  if (!partial || has("steps")) out.steps = steps(body.steps);
  if (!partial || has("checks")) out.checks = checks(body.checks);
  if (!partial || has("defaultOn")) out.defaultOn = !!body.defaultOn;
  return out;
}

// ---------- rotinas ----------

export async function getRoutineDefs(env) {
  return (await env.ROTINAS.get("routines", "json")) || {};
}

export async function setRoutineDefs(env, map) {
  await env.ROTINAS.put("routines", JSON.stringify(map));
}

/** Estado de cada rotina fica numa chave própria, para dois toggles simultâneos não se atropelarem. */
export async function getState(env, id, defaultOn) {
  const v = await env.ROTINAS.get(`state:${id}`);
  return v === null ? !!defaultOn : v === "1";
}

export async function setState(env, id, on) {
  await env.ROTINAS.put(`state:${id}`, on ? "1" : "0");
}

export async function getLastRun(env, id) {
  return env.ROTINAS.get(`lastrun:${id}`, "json");
}

export async function setLastRun(env, id, run) {
  await env.ROTINAS.put(`lastrun:${id}`, JSON.stringify(run));
}

/** Lista ordenada (ordem de criação) com estado e última execução. */
export async function listRoutines(env) {
  const defs = Object.values(await getRoutineDefs(env)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return Promise.all(
    defs.map(async (r) => ({ ...r, on: await getState(env, r.id, r.defaultOn), lastRun: await getLastRun(env, r.id) }))
  );
}

export async function requireRoutine(env, id) {
  const defs = await getRoutineDefs(env);
  if (!defs[id]) throw new HttpError(404, "rotina não encontrada");
  return { defs, routine: defs[id] };
}

export function nextOrder(defs) {
  return Object.values(defs).reduce((m, r) => Math.max(m, r.order ?? 0), 0) + 1;
}

export { isValidSlug };

// ---------- propostas da Alice ----------

export async function getPending(env) {
  return (await env.ROTINAS.get("pending_proposals", "json")) || [];
}

export async function setPending(env, list) {
  await env.ROTINAS.put("pending_proposals", JSON.stringify(list));
}

export function newProposalId() {
  return `prop-${randomHex(4)}`;
}

// ---------- tarefas ----------
// Ficam no Durable Object (consistência imediata entre o painel e a ponte/Alice).
// id = t<timestamp invertido>-<aleatório> (lista sai do mais novo pro mais antigo).

export const TASK_STATUSES = ["queued", "sent", "running", "done", "error", "send_failed"];

export function newTaskId() {
  return `t${invTs()}-${randomHex(3)}`;
}

export async function saveTask(env, task) {
  await fila(env).saveTask(task);
}

export async function getTask(env, id) {
  if (!/^t\d{13}-[0-9a-f]{6}$/.test(id)) return null;
  return fila(env).getTask(id);
}

export async function listTasks(env, limit = 50) {
  return fila(env).listTasks(limit);
}
