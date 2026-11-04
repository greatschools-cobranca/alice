// Trilha de auditoria: cada evento vira uma chave própria no KV (sem perda por escrita concorrente).
// O resumo do evento vai nos metadados da chave, então uma única listagem traz a linha do tempo.
import { invTs, randomHex, clip } from "./util.js";
import { sendMail, alertEmail } from "./mail.js";

const AUDIT_TTL_SECONDS = 60 * 60 * 24 * 180; // 180 dias

/**
 * Registra um evento. Se `alert` for true e a severidade for warn/error, manda e-mail na hora.
 * event: { type, severity: "info"|"warn"|"error", actor, summary, routineId?, routineName?, taskId?, details? }
 */
export async function record(env, ctx, event, { alert = false } = {}) {
  const at = event.at || new Date().toISOString();
  const key = `audit:${invTs(Date.parse(at))}:${randomHex(3)}`;
  const full = { ...event, at, severity: event.severity || "info", id: key.slice(6) };
  const meta = {
    at,
    type: clip(full.type, 40),
    sev: full.severity,
    actor: clip(full.actor || "", 40),
    rid: clip(full.routineId || "", 50),
    rname: clip(full.routineName || "", 80),
    tid: clip(full.taskId || "", 40),
    sum: clip(full.summary || "", 400),
  };
  await env.ROTINAS.put(key, JSON.stringify(full), { metadata: meta, expirationTtl: AUDIT_TTL_SECONDS });

  if (alert && (full.severity === "error" || full.severity === "warn")) {
    const send = (async () => {
      const { subject, html } = alertEmail(env, full);
      const res = await sendMail(env, subject, html);
      if (!res.ok && res.error !== "e-mail não configurado") {
        await env.ROTINAS.put(`audit:${invTs()}:${randomHex(3)}`, "{}", {
          metadata: { at: new Date().toISOString(), type: "mail_error", sev: "warn", actor: "torre", sum: clip(`Falha ao enviar alerta por e-mail: ${res.error}`, 400) },
          expirationTtl: AUDIT_TTL_SECONDS,
        });
      }
    })();
    if (ctx) ctx.waitUntil(send);
    else await send;
  }
  return full;
}

function fromMeta(k) {
  const m = k.metadata || {};
  return {
    id: k.name.slice(6),
    at: m.at,
    type: m.type,
    severity: m.sev,
    actor: m.actor,
    routineId: m.rid || undefined,
    routineName: m.rname || undefined,
    taskId: m.tid || undefined,
    summary: m.sum,
  };
}

/** Lista eventos do mais novo para o mais antigo. */
export async function listAudit(env, { limit = 100, sinceMs = 0, cursor } = {}) {
  const events = [];
  let cur = cursor;
  while (events.length < limit) {
    const page = await env.ROTINAS.list({ prefix: "audit:", limit: Math.min(1000, limit - events.length), cursor: cur });
    let stop = false;
    for (const k of page.keys) {
      const e = fromMeta(k);
      if (sinceMs && Date.parse(e.at) < sinceMs) {
        stop = true;
        break;
      }
      events.push(e);
    }
    if (stop || page.list_complete) return { events, cursor: null };
    cur = page.cursor;
    if (!page.keys.length) return { events, cursor: null };
  }
  return { events, cursor: cur };
}

export async function getAuditEvent(env, id) {
  return env.ROTINAS.get(`audit:${id}`, "json");
}
