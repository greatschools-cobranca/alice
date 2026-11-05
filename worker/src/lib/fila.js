// Fila da ponte de saída + histórico da conversa (Durable Object, consistência imediata).
//
// Modo "ponte": a Torre não acessa o gateway da Alice. Um programa no servidor da Alice
// (setup/ponte/ponte-torre.mjs) consulta esta fila por HTTPS de saída e repassa os pedidos
// para o gateway em localhost. Nada no servidor fica exposto à internet.
import { DurableObject } from "cloudflare:workers";

const CHAT_PENDING_TIMEOUT_MS = 90 * 1000; // conversa sem ser retirada pela ponte
const TASK_PENDING_TIMEOUT_MS = 30 * 60 * 1000; // tarefa esperando a ponte voltar
const TAKEN_TIMEOUT_MS = 15 * 60 * 1000; // retirada mas não concluída
const JOB_TTL_MS = 2 * 24 * 60 * 60 * 1000;
const HISTORY_MAX = 100;

function rand() {
  return [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class Fila extends DurableObject {
  // ---------- histórico da conversa (usado nos dois modos) ----------

  async getHistory(user) {
    return (await this.ctx.storage.get(`chat:${user}`)) || [];
  }

  async appendHistory(user, messages) {
    const list = await this.getHistory(user);
    list.push(...messages);
    await this.ctx.storage.put(`chat:${user}`, list.slice(-HISTORY_MAX));
  }

  async resetHistory(user) {
    await this.ctx.storage.delete(`chat:${user}`);
  }

  // ---------- tarefas (chave task:<id>; id começa com timestamp invertido → mais novas primeiro) ----------

  async saveTask(task) {
    await this.ctx.storage.put(`task:${task.id}`, task);
  }

  async getTask(id) {
    return (await this.ctx.storage.get(`task:${id}`)) || null;
  }

  async listTasks(limit = 50) {
    const map = await this.ctx.storage.list({ prefix: "task:", limit });
    return [...map.values()].map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      createdBy: t.createdBy,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      files: (t.files || []).length,
    }));
  }

  // ---------- fila ----------

  /** Vencimento de pedidos parados. Devolve o job atualizado (ou o mesmo). */
  async #expire(job, now = Date.now()) {
    if (job.status === "pending") {
      const limit = job.type === "chat" ? CHAT_PENDING_TIMEOUT_MS : TASK_PENDING_TIMEOUT_MS;
      if (now - job.createdAt > limit) {
        job.status = "error";
        job.error = "a ponte da Alice não respondeu (programa parado ou servidor fora do ar)";
        job.updatedAt = now;
        await this.ctx.storage.put(`job:${job.id}`, job);
      }
    } else if (job.status === "taken" && now - job.takenAt > TAKEN_TIMEOUT_MS) {
      job.status = "error";
      job.error = "a Alice demorou demais para responder (mais de 15 min)";
      job.updatedAt = now;
      await this.ctx.storage.put(`job:${job.id}`, job);
    }
    return job;
  }

  async enqueue(type, user, payload) {
    const now = Date.now();
    const job = { id: `j${now}${rand()}`, type, user, payload, status: "pending", createdAt: now, updatedAt: now, text: "" };
    await this.ctx.storage.put(`job:${job.id}`, job);
    return job;
  }

  /** Chamado pela ponte. Registra que ela está viva e entrega o pedido pendente mais antigo. */
  async next() {
    const now = Date.now();
    await this.ctx.storage.put("meta:lastSeen", now);
    const jobs = await this.ctx.storage.list({ prefix: "job:" });
    let picked = null;
    const stale = [];
    for (const [key, job] of jobs) {
      if (now - job.createdAt > JOB_TTL_MS) {
        stale.push(key);
        continue;
      }
      await this.#expire(job, now);
      if (!picked && job.status === "pending") picked = job;
    }
    if (stale.length) await this.ctx.storage.delete(stale);
    if (!picked) return null;
    picked.status = "taken";
    picked.takenAt = now;
    picked.updatedAt = now;
    await this.ctx.storage.put(`job:${picked.id}`, picked);
    return picked;
  }

  async progress(id, text) {
    const job = await this.ctx.storage.get(`job:${id}`);
    if (!job || job.status !== "taken") return null;
    job.text = String(text || "").slice(0, 100000);
    job.updatedAt = Date.now();
    await this.ctx.storage.put(`job:${id}`, job);
    return job;
  }

  /** Conclui o pedido. data: { text?, error?, runId? }. Devolve o job ou null se já estava encerrado. */
  async finish(id, data) {
    const job = await this.ctx.storage.get(`job:${id}`);
    if (!job || job.status === "done" || job.status === "error") return null;
    job.status = data.error ? "error" : "done";
    if (typeof data.text === "string") job.text = data.text.slice(0, 100000);
    if (data.error) job.error = String(data.error).slice(0, 2000);
    if (data.runId) job.runId = String(data.runId).slice(0, 200);
    job.updatedAt = Date.now();
    await this.ctx.storage.put(`job:${id}`, job);
    return job;
  }

  async get(id) {
    const job = await this.ctx.storage.get(`job:${id}`);
    return job ? this.#expire(job) : null;
  }

  async status() {
    return { lastSeen: (await this.ctx.storage.get("meta:lastSeen")) || null };
  }
}

/** Atalho: sempre a mesma instância (uma fila para a Torre inteira). */
export function fila(env) {
  return env.FILA.get(env.FILA.idFromName("torre"));
}
