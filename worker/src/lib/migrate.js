// Migração única dos dados da versão anterior da Torre (roda no cron e na importação; é idempotente).
//  - "state" (mapa único)        -> state:<id>
//  - "custom_routines"           -> entram em "routines" (criadas pela Alice)
//  - "log" (últimas 200 ações)   -> eventos de auditoria
import { getRoutineDefs, setRoutineDefs, nextOrder } from "./store.js";
import { invTs, randomHex, clip } from "./util.js";

export async function migrateLegacy(env) {
  if (await env.ROTINAS.get("migrated:v2")) return false;

  const legacyState = await env.ROTINAS.get("state", "json");
  if (legacyState) {
    for (const [id, on] of Object.entries(legacyState)) {
      if ((await env.ROTINAS.get(`state:${id}`)) === null) await env.ROTINAS.put(`state:${id}`, on ? "1" : "0");
    }
  }

  const custom = await env.ROTINAS.get("custom_routines", "json");
  if (custom && Object.keys(custom).length) {
    const defs = await getRoutineDefs(env);
    for (const r of Object.values(custom)) {
      if (!defs[r.id]) defs[r.id] = { ...r, checks: r.checks || [], order: nextOrder(defs), createdBy: "alice" };
    }
    await setRoutineDefs(env, defs);
  }

  const log = await env.ROTINAS.get("log", "json");
  if (Array.isArray(log)) {
    const label = { enable: "Ligou", disable: "Desligou", propose_create: "Alice propôs", propose_edit: "Alice propôs alterar", approve_create: "Aprovou", approve_edit: "Aprovou edição de", reject_create: "Rejeitou", reject_edit: "Rejeitou edição de" };
    for (const e of log) {
      if (!e?.at) continue;
      await env.ROTINAS.put(`audit:${invTs(Date.parse(e.at))}:${randomHex(3)}`, JSON.stringify({ ...e, legacy: true }), {
        metadata: {
          at: e.at,
          type: `legacy_${clip(e.action, 30)}`,
          sev: "info",
          actor: clip(e.by || "", 40),
          rid: clip(e.routineId || "", 50),
          rname: clip(e.routineName || "", 80),
          sum: clip(`${label[e.action] || e.action} "${e.routineName || e.routineId}" (registro da versão anterior)`, 400),
        },
        expirationTtl: 60 * 60 * 24 * 180,
      });
    }
  }

  await env.ROTINAS.put("migrated:v2", new Date().toISOString());
  return true;
}
