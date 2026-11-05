// Somente leitura; não consulta /next e não dispara nenhum turno de agente.
import { readFileSync } from "node:fs";
import { Rpc } from "./lib/rpc.mjs";
import { fingerprint } from "./lib/engine.mjs";
const rpc = new Rpc(JSON.parse(readFileSync("/run/secrets/gateway.json", "utf8")).token);
try {
  const health = await rpc.call("health");
  const list = await rpc.call("cron.list", { includeDisabled: true });
  if (!health?.ok || !Array.isArray(list.jobs)) throw new Error("invalid_gateway_contract");
  const target = new Set(["36406b0a-7d43-42bb-9241-eb26bfb722da", "4eaa6b1a-92dc-4f14-921f-1b0dcb8e3eef", "ae87c0ef-c6c5-45bc-a189-514afc67432f"]);
  console.log(JSON.stringify({ gateway: true, cronRead: true, count: list.jobs.length, jobs: list.jobs.filter(j => target.has(j.id)).map(j => ({ id: j.id, enabled: j.enabled, running: !!j.state?.runningAtMs, fingerprint: fingerprint(j) })), rssMiB: Math.round(process.memoryUsage().rss / 1048576) }));
} catch { console.log(JSON.stringify({ gateway: false, reason: "gateway_contract_not_confirmed" })); process.exitCode = 1; }
finally { rpc.close(); }
