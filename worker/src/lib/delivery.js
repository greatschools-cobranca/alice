// Modo ponte: atualiza a tarefa conforme a entrega à Alice (usado pela API e pelo cron).
import { record } from "./audit.js";
import { saveTask } from "./store.js";
import { fila } from "./fila.js";
import { clip } from "./util.js";

/** Modo ponte: registra se a tarefa chegou (ou não) na Alice. data: { error?, runId? } */
export async function applyTaskDelivery(env, ctx, task, data, actor) {
  if (task.status !== "queued") return task; // já atualizada (ex.: Alice marcou running antes)
  const now = new Date().toISOString();
  task.status = data.error ? "send_failed" : "sent";
  if (data.error) task.error = data.error;
  if (data.runId) task.runId = data.runId;
  task.updatedAt = now;
  task.history.push({ at: now, status: task.status, by: actor, note: data.error || undefined });
  await saveTask(env, task);
  await record(
    env,
    ctx,
    {
      type: data.error ? "task_send_failed" : "task_sent",
      severity: data.error ? "error" : "info",
      actor,
      taskId: task.id,
      routineId: task.routineId,
      routineName: task.routineName,
      summary: data.error
        ? `Não consegui entregar a tarefa "${task.title}" para a Alice: ${clip(data.error, 200)}`
        : `Tarefa "${task.title}" entregue à Alice`,
    },
    { alert: !!data.error }
  );
  return task;
}

/** Se a tarefa está na fila e o pedido venceu (ponte parada), marca como não entregue. */
export async function syncQueuedTask(env, ctx, task) {
  if (task.status !== "queued" || !task.jobId) return task;
  const job = await fila(env).get(task.jobId);
  if (job && job.status === "error") return applyTaskDelivery(env, ctx, task, { error: job.error }, "torre");
  return task;
}
