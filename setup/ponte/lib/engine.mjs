import { createHash } from "node:crypto";
export function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}
export function fingerprint(job) {
  return createHash("sha256").update(JSON.stringify(canonical({ agentId: job.agentId, sessionKey: job.sessionKey, schedule: job.schedule, sessionTarget: job.sessionTarget, payload: job.payload, delivery: job.delivery, trigger: job.trigger }))).digest("hex");
}
export class Engine {
  constructor({ api, rpc, journal, mappings }) { Object.assign(this, { api, rpc, journal, mappings }); }
  async flush() {
    for (const r of this.journal.pendingResults()) {
      const ack = await this.api(`/jobs/${r.id}/result`, "POST", r);
      if (!ack?.ok || ack.id !== r.id || ack.status !== r.status) throw new Error("invalid_ack");
      this.journal.ack(r.id);
    }
  }
  result(record, status, reason, runId = record.runId) {
    record.phase = status; record.runId = runId;
    this.journal.put(record, { claim: record.claim, status, reason, runId });
  }
  async handle(job) {
    if (!/^r[0-9a-f]{32}$/.test(job?.id || "") || typeof job.claim !== "string") throw new Error("invalid_claim");
    let record = this.journal.get(job.id);
    if (record && record.claim !== job.claim) throw new Error("claim_changed");
    if (!record && (job.resumed === true || job.status !== "claimed")) {
      this.result({ id: job.id, claim: job.claim }, "uncertain", "unknown"); return;
    }
    if (record?.phase === "dispatching") { this.result(record, "uncertain", "unknown"); return; }
    if ((record?.phase === "uncertain" && !record.runId) || ["done", "error", "rejected", "skipped"].includes(record?.phase)) return;
    const mapping = this.mappings[job.routineId];
    record ||= { id: job.id, claim: job.claim, phase: "claimed", routineId: job.routineId };
    if (!mapping || mapping.version !== job.version) { this.result(record, "rejected", "version"); return; }
    if (record.phase === "accepted" || (record.phase === "uncertain" && record.runId)) {
      const logs = await this.rpc.call("cron.runs", { id: mapping.manualJobId, limit: 100 });
      const finished = logs.entries?.find(r => r.runId === record.runId && r.action === "finished");
      if (finished) {
        const skipped = finished.status === "skipped" || finished.triggerEval?.fired === false || finished.triggerFired === false;
        this.result(record, skipped ? "skipped" : finished.status === "ok" ? "done" : "error", finished.status === "ok" ? "native_ok" : "native_error");
      } else if (Date.now() - (record.acceptedAt || 0) > 3 * 3600000) this.result(record, "uncertain", "unknown");
      else this.result(record, "accepted", undefined);
      return;
    }
    this.journal.put(record);
    const control = await this.api("/control");
    const routine = control.routines?.find(r => r.id === job.routineId);
    if (control.protocol !== 2 || routine?.on !== true) { this.result(record, "rejected", "off"); return; }
    if (routine.version !== job.version) { this.result(record, "rejected", "version"); return; }
    const list = await this.rpc.call("cron.list", { includeDisabled: true });
    const native = list.jobs?.find(j => j.id === mapping.manualJobId);
    if (!native?.enabled || fingerprint(native) !== mapping.fingerprint) { this.result(record, "rejected", "version"); return; }
    if (list.jobs.some(j => j.state?.runningAtMs)) return; // espera; não interrompe trabalhos existentes
    // Segunda leitura imediata. O gatilho nativo faz a decisão final no início da execução.
    const latest = await this.api("/control");
    if (!latest.routines?.some(r => r.id === job.routineId && r.on === true && r.version === job.version)) { this.result(record, "rejected", "off"); return; }
    if (mapping.guardVerified !== true) { this.result(record, "rejected", "version"); return; }
    record.phase = "dispatching"; this.journal.put(record);
    let reply;
    try { reply = await this.rpc.call("cron.run", { id: mapping.manualJobId, mode: "force" }); }
    catch { this.result(record, "uncertain", "unknown"); return; }
    if (reply?.ok === true && reply.enqueued === true && typeof reply.runId === "string") { record.acceptedAt = Date.now(); this.result(record, "accepted", undefined, reply.runId); }
    else if (reply?.ok === true && reply.ran === false) this.result(record, "skipped", "busy");
    else this.result(record, "uncertain", "unknown");
  }
}
