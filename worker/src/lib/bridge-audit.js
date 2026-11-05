// Auditoria e alertas da ponte (protocolo 2).
// Complementa bridge-state.js sem alterar o protocolo: só registra eventos e envia alertas.
import { record } from "./audit.js";

const REASON = {
  busy: "havia outra rotina em execução no OpenClaw",
  off: "a rotina estava desligada na Torre",
  version: "a rotina mudou ou o mapeamento na VPS não está homologado",
  gateway: "o gateway da Alice estava indisponível",
  unknown: "a ponte não conseguiu confirmar o resultado",
  native_error: "o job nativo do OpenClaw terminou com erro",
  native_ok: "",
};

// status do job -> [severidade, texto]
const STATUS = {
  accepted: ["info", "entregue à Alice; execução nativa iniciada"],
  done: ["info", "execução concluída (término técnico do job nativo; não comprova o resultado de negócio)"],
  skipped: ["warn", "não executada"],
  rejected: ["warn", "pedido recusado, nada foi executado"],
  error: ["error", "a execução terminou com erro"],
  uncertain: ["error", "resultado incerto: confira no OpenClaw antes de pedir de novo (a ponte não repete a execução)"],
};

// status da tarefa que pedem atenção de alguém
const TASK_ALERT = {
  uncertain: ["error", "resultado incerto: confira no OpenClaw antes de pedir de novo"],
  error: ["error", "a execução terminou com erro"],
  send_failed: ["warn", "pedido recusado, nada foi executado"],
  skipped: ["warn", "não executada"],
};

async function once(env, key) {
  if (await env.ROTINAS.get(key)) return false;
  await env.ROTINAS.put(key, "1", { expirationTtl: 60 * 60 * 24 * 30 });
  return true;
}

/** Pedido de execução feito pelo painel. */
export async function auditRequest(env, ctx, user, task) {
  await record(env, ctx, {
    type: "routine_run_requested",
    actor: user,
    taskId: task.id,
    routineId: task.routineId,
    routineName: task.routineName,
    summary: `Pediu a execução da rotina "${task.routineName}" pela Torre`,
  });
}

/**
 * Resultado devolvido pela ponte. Só registra quando o status realmente muda
 * (confirmações repetidas da ponte são idempotentes e não geram evento novo).
 */
export async function auditBridgeResult(env, ctx, previousStatus, job, task) {
  if (!job || previousStatus === job.status) return;
  const [severity, text] = STATUS[job.status] || ["warn", job.status];
  const reason = REASON[job.reason] || "";
  const name = task?.routineName || job.routineId;
  const alert = severity !== "info";
  if (alert) await once(env, `alerted:task:${job.taskId}:${task?.status || job.status}`); // evita alerta duplicado no cron
  await record(
    env,
    ctx,
    {
      type: `routine_run_${job.status}`,
      severity,
      actor: "ponte",
      taskId: job.taskId,
      routineId: job.routineId,
      routineName: name,
      summary: `Rotina "${name}": ${text}${reason ? ` — ${reason}` : ""}${job.user ? ` (pedido por ${job.user})` : ""}`,
      details: job.runId ? `runId no OpenClaw: ${job.runId}` : undefined,
    },
    { alert }
  );
}

/**
 * Rede de segurança do cron: tarefas que terminaram num estado que pede atenção sem ter
 * passado pela rota de resultado (ex.: pedido recusado ao ser retirado da fila) recebem alerta uma vez.
 */
export async function alertTaskStates(env, ctx, tasks) {
  for (const t of tasks) {
    const entry = TASK_ALERT[t.status];
    if (!entry) continue;
    if (!(await once(env, `alerted:task:${t.id}:${t.status}`))) continue;
    await record(
      env,
      ctx,
      {
        type: `task_${t.status}`,
        severity: entry[0],
        actor: "torre",
        taskId: t.id,
        summary: `"${t.title}": ${entry[1]}`,
      },
      { alert: true }
    );
  }
}
