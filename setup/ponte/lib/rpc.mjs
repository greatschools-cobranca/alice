import { randomUUID } from "node:crypto";

// Cliente mínimo para o protocolo 4 da versão 2026.7.1-2.
// Só usa loopback dentro da namespace de rede da Alice; nenhuma porta nova.
export class Rpc {
  constructor(token, { active = false, timeout = 15000 } = {}) {
    this.token = token; this.active = active; this.timeout = timeout; this.pending = new Map();
  }
  async connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const w = this.ws = new WebSocket("ws://127.0.0.1:18789");
      let connected = false;
      const timer = setTimeout(() => { reject(new Error("gateway_timeout")); w.close(); }, this.timeout);
      w.addEventListener("message", e => {
        if (typeof e.data !== "string" || e.data.length > 4 * 1024 * 1024) return w.close();
        let frame; try { frame = JSON.parse(e.data); } catch { return w.close(); }
        if (frame.event === "connect.challenge" && !connected) {
          connected = true;
          w.send(JSON.stringify({ type: "req", id: "connect", method: "connect", params: {
            minProtocol: 4, maxProtocol: 4,
            client: { id: "cli", version: "torre-bridge-2", platform: "linux", mode: "cli" },
            role: "operator", scopes: [this.active ? "operator.admin" : "operator.read"], auth: { token: this.token },
          } }));
        }
        if (frame.type !== "res") return;
        if (frame.id === "connect") {
          clearTimeout(timer);
          if (frame.ok && frame.payload?.type === "hello-ok") resolve();
          else { reject(new Error("gateway_auth_or_protocol")); w.close(); }
          return;
        }
        const req = this.pending.get(frame.id);
        if (!req) return;
        clearTimeout(req.timer); this.pending.delete(frame.id);
        frame.ok ? req.resolve(frame.payload) : req.reject(new Error("gateway_rejected"));
      });
      w.addEventListener("error", () => {});
      w.addEventListener("close", () => {
        clearTimeout(timer); this.ready = null;
        reject(new Error("gateway_closed"));
        for (const req of this.pending.values()) { clearTimeout(req.timer); req.reject(new Error("gateway_closed")); }
        this.pending.clear();
      });
    });
    return this.ready;
  }
  async call(method, params = {}) {
    const reads = ["health", "cron.list", "cron.runs"];
    if (!reads.includes(method) && !(this.active && method === "cron.run")) throw new Error("rpc_not_allowed");
    if (method === "cron.run" && (!/^[0-9a-f-]{36}$/.test(params.id || "") || params.mode !== "force")) throw new Error("rpc_invalid_target");
    await this.connect();
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("gateway_timeout")); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ type: "req", id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error("gateway_closed")); }
    });
  }
  close() { this.ws?.close(); }
}
