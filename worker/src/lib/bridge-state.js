// Protocolo 2. Todas as decisões de controle ficam no mesmo Durable Object.
// Não reaproveita pedidos livres da fila antiga e nunca reentrega uma operação incerta.
const PREFIX = "bridge2:";
const MAX_QUEUE = 100;
const MAX_RECEIPTS = 500;
const RETENTION = 7 * 86400000;
export const PROTOCOL = 2;
export class BridgeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new BridgeError(status, message); };
// Durable Object RPC não precisa preservar propriedades de uma exceção customizada.
export async function bridgeReply(call) {
  try { return { value: await call() }; }
  catch (e) { if (e instanceof BridgeError) return { failure: { status: e.status, message: e.message } }; throw e; }
}
export function bridgeValue(reply) {
  if (reply.failure) throw new BridgeError(reply.failure.status, reply.failure.message);
  return reply.value;
}
export class BridgeState {
  constructor(storage, now = Date.now) { this.storage = storage; this.now = now; }
  async control(seed) {
    return this.storage.transaction(async (tx) => {
      let c = await tx.get(PREFIX + "control");
      if (!c && seed) {
        c = { revision: 1, defs: seed.defs, states: seed.states };
        await tx.put(PREFIX + "control", c);
      }
      return c || null;
    });
  }
  async replaceDefs(defs, expected) {
    return this.storage.transaction(async (tx) => {
      const c = await tx.get(PREFIX + "control");
      if (!c || c.revision !== expected) fail(409, "As rotinas mudaram; atualize a página antes de salvar.");
      if (Object.keys(defs).length > 100) fail(400, "Limite de 100 rotinas.");
      const states = {};
      for (const [id, def] of Object.entries(defs)) states[id] = Object.hasOwn(c.states, id) ? c.states[id] : !!def.defaultOn;
      c.defs = defs; c.states = states; c.revision++;
      await tx.put(PREFIX + "control", c);
      return c;
    });
  }
  async setState(id, on) {
    return this.storage.transaction(async (tx) => {
      const c = await tx.get(PREFIX + "control");
      if (!c?.defs[id]) fail(404, "Rotina não encontrada.");
      c.states[id] = on === true; c.revision++;
      await tx.put(PREFIX + "control", c);
      return c;
    });
  }
  async enqueue(user, requestId, routineId, version, task) {
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(requestId || "")) fail(400, "Identificador de pedido inválido.");
    return this.storage.transaction(async (tx) => {
      const now = this.now();
      const activeId = await tx.get(PREFIX + "active");
      const queue = await tx.get(PREFIX + "queue") || [];
      const previous = await tx.get(PREFIX + "receipts") || [];
      const receipts = previous.filter(r => now - r.at < RETENTION || r.id === activeId || queue.includes(r.id));
      const old = receipts.find(r => r.user === user && r.requestId === requestId);
      if (old) {
        if (old.routineId !== routineId || old.version !== version) fail(409, "Pedido já utilizado para outra operação.");
        return { ...await tx.get(PREFIX + "job:" + old.id), duplicate: true };
      }
      const c = await tx.get(PREFIX + "control");
      const def = c?.defs[routineId];
      if (!def || !c.states[routineId]) fail(409, "Rotina desligada ou não cadastrada.");
      if (version !== await routineVersion(def)) fail(409, "A rotina mudou; revise antes de executar.");
      if (queue.length >= MAX_QUEUE || receipts.length >= MAX_RECEIPTS) fail(429, "Limite de pedidos; aguarde a retenção ou revise a fila.");
      // O id é do pedido, independente de conexão, clique ou tentativa de entrega.
      const id = "r" + crypto.randomUUID().replaceAll("-", "");
      const job = { id, routineId, version, taskId: task.id, user, status: "pending", createdAt: now, updatedAt: now };
      await tx.put(PREFIX + "job:" + id, job);
      await tx.put("task:" + task.id, { ...task, jobId: id, bridgeProtocol: PROTOCOL });
      await tx.put(PREFIX + "queue", [...queue, id]);
      await tx.put(PREFIX + "receipts", [...receipts, { user, requestId, routineId, version, id, at: now }]);
      // Limpeza limitada à mesma janela; sem varrer todos os jobs a cada poll.
      for (const r of previous) if (now - r.at >= RETENTION && !queue.includes(r.id) && r.id !== activeId) await tx.delete(PREFIX + "job:" + r.id);
      return job;
    });
  }
  async heartbeat(gateway, mode = "observe") {
    const now = this.now(), key = PREFIX + "heartbeat";
    const previous = await this.storage.get(key);
    const next = { lastSeen: now, gateway: gateway === true, mode: mode === "active" ? "active" : "observe", protocol: PROTOCOL };
    if (!previous || now - previous.lastSeen >= 30000 || previous.gateway !== next.gateway || previous.mode !== next.mode) await this.storage.put(key, next);
    return next;
  }
  async status() { return { protocol: PROTOCOL, ...await this.storage.get(PREFIX + "heartbeat") }; }
  async next() {
    return this.storage.transaction(async (tx) => {
      const now = this.now(), queue = await tx.get(PREFIX + "queue") || [];
      const activeId = await tx.get(PREFIX + "active");
      if (activeId) {
        const job = await tx.get(PREFIX + "job:" + activeId);
        if (!job) fail(503, "Fila inconsistente; intervenção necessária.");
        if (now - job.updatedAt > 120000 && ["claimed", "accepted"].includes(job.status)) {
          job.status = "uncertain"; job.updatedAt = now;
          await tx.put(PREFIX + "job:" + job.id, job);
        }
        return { ...job, resumed: true }; // mesma concessão, nunca cria uma segunda execução
      }
      while (queue.length) {
        const id = queue.shift(), job = await tx.get(PREFIX + "job:" + id);
        if (!job || job.status !== "pending") continue;
        const c = await tx.get(PREFIX + "control");
        const def = c?.defs[job.routineId];
        if (now - job.createdAt > 1800000 || !def || !c.states[job.routineId] || await routineVersion(def) !== job.version) {
          job.status = "rejected"; job.updatedAt = now;
          await tx.put(PREFIX + "job:" + id, job);
          await this.updateTask(tx, job);
          continue;
        }
        job.status = "claimed"; job.claim = crypto.randomUUID(); job.updatedAt = now;
        await tx.put(PREFIX + "job:" + id, job);
        await tx.put(PREFIX + "queue", queue);
        await tx.put(PREFIX + "active", id);
        return { ...job, resumed: false };
      }
      await tx.put(PREFIX + "queue", queue);
      return null;
    });
  }
  async result(id, claim, result) {
    const allowed = ["accepted", "uncertain", "done", "error", "rejected", "skipped"];
    if (!allowed.includes(result.status)) fail(400, "Resultado inválido.");
    return this.storage.transaction(async (tx) => {
      const job = await tx.get(PREFIX + "job:" + id);
      if (!job || job.claim !== claim) fail(409, "Concessão inválida.");
      if (["done", "error", "rejected", "skipped"].includes(job.status)) {
        if (job.status !== result.status) fail(409, "Resultado final já registrado.");
        return job; // confirmação idempotente após perda da resposta HTTP
      }
      if (job.status === "accepted" && result.status === "rejected") fail(409, "Entrega aceita não pode ser declarada rejeitada.");
      job.status = result.status; job.updatedAt = this.now();
      job.reason = ["busy", "off", "version", "gateway", "unknown", "native_error", "native_ok"].includes(result.reason) ? result.reason : undefined;
      if (typeof result.runId === "string" && /^[\w:-]{1,180}$/.test(result.runId)) job.runId = result.runId;
      await tx.put(PREFIX + "job:" + id, job);
      if (["done", "error", "rejected", "skipped"].includes(job.status)) await tx.delete(PREFIX + "active");
      await this.updateTask(tx, job);
      return job;
    });
  }
  async updateTask(tx, job) {
    const task = await tx.get("task:" + job.taskId);
    if (!task) return;
    task.status = { pending: "queued", claimed: "queued", accepted: "sent", uncertain: "uncertain", done: "done", error: "error", rejected: "send_failed", skipped: "skipped" }[job.status];
    task.updatedAt = new Date(job.updatedAt).toISOString();
    if (job.runId) task.runId = job.runId;
    // Evidência técnica de conclusão do agendador; não prova validação do resultado de negócio.
    task.evidence = { source: "native_cron", status: job.status, reason: job.reason, at: task.updatedAt };
    await tx.put("task:" + task.id, task);
  }
  async get(id) { return await this.storage.get(PREFIX + "job:" + id) || null; }
}
// Revisão canônica: alteração das instruções invalida pedidos e mapeamentos anteriores.
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export async function routineVersion(def) {
  const value = JSON.stringify(canonical({ name: def.name, description: def.description, prompt: def.prompt, steps: def.steps, schedule: def.schedule }));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
