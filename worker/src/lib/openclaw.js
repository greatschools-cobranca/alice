// Protocolo 2: a Torre não recebe token nem chama endpoints do Gateway.
import { fila } from "./fila.js";
export const BRIDGE_ONLINE_MS = 120 * 1000;
export function bridgeMode(env) { return !!env.BRIDGE_API_KEY; }
export function chatConfigured() { return false; }
export function hooksConfigured(env) { return bridgeMode(env) && env.ROUTINE_EXECUTION_ENABLED === "true"; }
export async function bridgeStatus(env) {
  const status = await fila(env).bridgeStatus();
  return { ...status, online: !!status.lastSeen && Date.now() - status.lastSeen < BRIDGE_ONLINE_MS };
}
export async function ping(env) {
  if (!bridgeMode(env)) return { ok: false, mode: "ponte", reason: "chave própria da ponte não configurada" };
  const st = await bridgeStatus(env);
  return {
    ok: st.online && st.gateway === true,
    mode: "ponte",
    bridge: st,
    reason: !st.online ? "ponte sem verificação recente" : !st.gateway ? "gateway não verificado" : null,
  };
}
