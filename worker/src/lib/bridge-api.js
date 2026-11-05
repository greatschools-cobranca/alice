import { requireBridge } from "./auth.js";
import { fila } from "./fila.js";
import { getRoutineDefs } from "./store.js";
import { routineVersion, PROTOCOL, bridgeValue } from "./bridge-state.js";
import { HttpError, json, readJson } from "./util.js";

export async function controlSnapshot(env) {
  await getRoutineDefs(env);
  const c = await fila(env).control();
  return { protocol: PROTOCOL, revision: c.revision, routines: await Promise.all(Object.values(c.defs).map(async def => ({ id: def.id, name: def.name, on: c.states[def.id] === true, version: await routineVersion(def) }))) };
}
export async function routeBridge(request, env, path, method) {
  requireBridge(request, env);
  if (path === "/api/bridge/v2/status" && method === "GET") return json(await fila(env).bridgeStatus());
  if (path === "/api/bridge/v2/control" && method === "GET") return json(await controlSnapshot(env));
  if (path === "/api/bridge/v2/heartbeat" && method === "POST") {
    const body = await readJson(request);
    if (body.protocol !== PROTOCOL) throw new HttpError(409, "versão incompatível da ponte");
    return json(await fila(env).bridgeHeartbeat(body.gateway === true, body.mode));
  }
  if (path === "/api/bridge/v2/next" && method === "POST") {
    if (env.ROUTINE_EXECUTION_ENABLED !== "true") throw new HttpError(503, "execução ainda não homologada");
    const body = await readJson(request);
    if (body.protocol !== PROTOCOL) throw new HttpError(409, "versão incompatível da ponte");
    return json({ protocol: PROTOCOL, job: await fila(env).bridgeNext() });
  }
  const m = path.match(/^\/api\/bridge\/v2\/jobs\/(r[0-9a-f]{32})\/result$/);
  if (m && method === "POST") {
    const body = await readJson(request);
    const job = bridgeValue(await fila(env).bridgeResult(m[1], body.claim, body));
    return json({ ok: true, id: job.id, status: job.status });
  }
  throw new HttpError(404, "rota da ponte não encontrada");
}
