// Tarefas agendadas (a cada 30 min, ver wrangler.toml):
//  1. Rotina ligada que deveria ter rodado até o horário combinado e não reportou → alerta imediato.
//  2. Tarefa enviada à Alice parada há mais de 3h → alerta imediato.
//  3. Depois das 18:30 (São Paulo), uma vez por dia → e-mail com o resumo das últimas 24h.
import { spNow, spDate } from "./lib/util.js";
import { record, listAudit } from "./lib/audit.js";
import { listRoutines, listTasks } from "./lib/store.js"; // tarefas ficam no Durable Object
import { sendMail, digestEmail, mailConfigured } from "./lib/mail.js";
import { migrateLegacy } from "./lib/migrate.js";
import { getTask } from "./lib/store.js";
import { syncQueuedTask } from "./lib/delivery.js";
import { bridgeMode, bridgeStatus } from "./lib/openclaw.js";

const DIGEST_AFTER = "18:30";
const BRIDGE_OFFLINE_ALERT_MS = 10 * 60 * 1000;

/** Modo ponte: avisa uma vez quando a ponte para de dar sinal (só depois de ter funcionado ao menos uma vez). */
async function checkBridge(env, ctx) {
  if (!bridgeMode(env)) return;
  const { lastSeen } = await bridgeStatus(env);
  if (!lastSeen || Date.now() - lastSeen < BRIDGE_OFFLINE_ALERT_MS) return;
  if (!(await once(env, `alerted:bridge:${lastSeen}`, 60 * 60 * 24 * 30))) return;
  await record(
    env,
    ctx,
    {
      type: "bridge_offline",
      severity: "error",
      actor: "torre",
      summary: `A ponte da Alice parou de responder (último sinal: ${new Date(lastSeen).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}). Conversa e tarefas pela Torre estão paradas.`,
    },
    { alert: true }
  );
}

/** Tarefas que venceram na fila (ponte parada) passam a "não entregue", com alerta. */
async function syncQueued(env, ctx) {
  for (const t of await listTasks(env, 100)) {
    if (t.status !== "queued") continue;
    const task = await getTask(env, t.id);
    if (task) await syncQueuedTask(env, ctx, task);
  }
}
const STALE_TASK_MS = 3 * 60 * 60 * 1000;

async function once(env, key, ttlSeconds) {
  if (await env.ROTINAS.get(key)) return false;
  await env.ROTINAS.put(key, "1", { expirationTtl: ttlSeconds });
  return true;
}

async function checkOverdue(env, ctx, now) {
  const routines = await listRoutines(env);
  for (const r of routines) {
    if (!r.on || !Array.isArray(r.checks)) continue;
    for (const c of r.checks) {
      if (!c.days.includes(now.weekday) || now.time < c.by) continue;
      const done = await env.ROTINAS.get(`runday:${r.id}:${now.date}`);
      if (done) continue;
      if (!(await once(env, `alerted:overdue:${r.id}:${now.date}:${c.by}`, 60 * 60 * 48))) continue;
      const lr = r.lastRun;
      const lastInfo = lr && spDate(lr.at) === now.date ? ` Último status hoje: ${lr.status}${lr.summary ? ` — ${lr.summary}` : ""}.` : " A Alice não reportou nenhuma execução hoje.";
      await record(
        env,
        ctx,
        {
          type: "run_overdue",
          severity: "error",
          actor: "torre",
          routineId: r.id,
          routineName: r.name,
          summary: `Rotina "${r.name}" não concluiu até ${c.by}.${lastInfo}`,
        },
        { alert: true }
      );
    }
  }
}

async function checkStaleTasks(env, ctx) {
  const tasks = await listTasks(env, 100);
  for (const t of tasks) {
    if (!["sent", "running"].includes(t.status)) continue;
    if (Date.now() - Date.parse(t.updatedAt || t.createdAt) < STALE_TASK_MS) continue;
    if (!(await once(env, `alerted:task:${t.id}`, 60 * 60 * 24 * 7))) continue;
    await record(
      env,
      ctx,
      {
        type: "task_stale",
        severity: "warn",
        actor: "torre",
        taskId: t.id,
        summary: `Tarefa "${t.title}" está sem resposta da Alice há mais de 3h (status: ${t.status}).`,
      },
      { alert: true }
    );
  }
}

async function sendDigest(env, ctx, now) {
  if (!mailConfigured(env) || now.time < (env.DIGEST_AFTER || DIGEST_AFTER)) return;
  if (!(await once(env, `digest:${now.date}`, 60 * 60 * 48))) return;
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const { events } = await listAudit(env, { limit: 1000, sinceMs: since });
  const routines = await listRoutines(env);
  const lastRuns = Object.fromEntries(routines.map((r) => [r.id, r.lastRun]));
  const openTasks = (await listTasks(env, 100)).filter((t) => ["queued", "sent", "running", "send_failed"].includes(t.status));
  const [y, m, d] = now.date.split("-");
  const { subject, html } = digestEmail(env, `${d}/${m}/${y}`, events, routines, lastRuns, openTasks);
  const res = await sendMail(env, subject, html);
  if (!res.ok) {
    await env.ROTINAS.delete(`digest:${now.date}`); // tenta de novo na próxima rodada
    if (await once(env, `alerted:digest:${now.date}`, 60 * 60 * 48)) await record(env, ctx, { type: "mail_error", severity: "warn", actor: "torre", summary: `Falha ao enviar o resumo diário: ${res.error}` });
  }
}

export async function scheduled(event, env, ctx) {
  await migrateLegacy(env);
  const now = spNow(new Date(event.scheduledTime || Date.now()));
  await checkOverdue(env, ctx, now);
  await checkBridge(env, ctx);
  await syncQueued(env, ctx);
  await checkStaleTasks(env, ctx);
  await sendDigest(env, ctx, now);
}
