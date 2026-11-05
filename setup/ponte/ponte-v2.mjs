import { readFileSync, writeFileSync } from "node:fs";
import { Journal } from "./lib/journal.mjs";
import { Rpc } from "./lib/rpc.mjs";
import { Engine } from "./lib/engine.mjs";
import { transport } from "./lib/transport.mjs";

async function main() {
const cfg = JSON.parse(readFileSync("/config/install.json", "utf8"));
if (!["observe", "active"].includes(cfg.mode)) throw new Error("invalid_mode");
const active = cfg.mode === "active";
const mappings = Object.values(cfg.mappings || {});
if (active && (!mappings.length || mappings.length > 100 || !mappings.every(m => m.guardVerified === true))) throw new Error("native_guards_not_verified");
const gateway = JSON.parse(readFileSync("/run/secrets/gateway.json", "utf8"));
const bridgeKey = readFileSync("/run/secrets/bridge-key", "utf8").trim();
const rpc = new Rpc(gateway.token, { active });
const api = transport(cfg.origin, bridgeKey);
const journal = new Journal("/state/journal.sqlite");
const engine = new Engine({ api, rpc, journal, mappings: cfg.mappings || {} });
let stopped = false, delay = 10000;
process.on("SIGTERM", () => { stopped = true; });
process.on("SIGINT", () => { stopped = true; });
const safeCodes = new Set(["gateway_timeout", "gateway_auth_or_protocol", "gateway_closed", "gateway_rejected", "torre_auth", "torre_protocol_not_published", "torre_http", "torre_invalid_json", "torre_response_size", "invalid_ack", "journal_capacity"]);
function health(status, code) {
  writeFileSync("/state/health.json", JSON.stringify({ at: new Date().toISOString(), status, code, mode: cfg.mode, protocol: 2 }), { mode: 0o600 });
}
while (!stopped) {
  try {
    const local = await rpc.call("health");
    const localOk = local?.ok === true;
    const status = await api("/status");
    if (status.protocol !== 2) throw new Error("torre_protocol_not_published");
    await api("/heartbeat", "POST", { protocol: 2, gateway: localOk, mode: cfg.mode });
    await engine.flush();
    if (active && localOk) {
      const next = await api("/next", "POST", { protocol: 2 });
      if (next.protocol !== 2) throw new Error("torre_protocol_not_published");
      if (next.job) await engine.handle(next.job);
      await engine.flush();
      delay = next.job ? 10000 : Math.min(delay + 5000, 30000);
    } else delay = 30000;
    health(localOk ? "connected" : "gateway_unhealthy");
  } catch (e) {
    const code = safeCodes.has(e.message) ? e.message : "bridge_failure";
    health("waiting", code);
    console.error(JSON.stringify({ event: "bridge_waiting", code }));
    delay = Math.min(Math.max(delay * 2, 10000), 60000);
  }
  // Fracionado para desligamento sem aguardar um minuto.
  for (let slept = 0; slept < delay && !stopped; slept += 500) await new Promise(r => setTimeout(r, 500));
}
rpc.close(); journal.close();

}
main().catch(() => { console.error("bridge_initialization_failed"); process.exitCode = 1; });
