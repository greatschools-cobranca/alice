// Ponte com o gateway do OpenClaw (onde a Alice roda).
//  - Conversa: POST /v1/chat/completions (streaming), sessão própria por usuário da Torre.
//  - Tarefas: POST /hooks/agent (assíncrono); a Alice devolve o resultado pela API da Torre.
// Docs: https://docs.openclaw.ai/gateway/openai-http-api e https://docs.openclaw.ai/automation/cron-jobs/webhooks
import { HttpError } from "./util.js";

import { fila } from "./fila.js";

export const BRIDGE_ONLINE_MS = 30 * 1000;

/**
 * Modo ponte: sem OPENCLAW_BASE_URL, a Torre não chama o gateway — põe os pedidos numa fila
 * que a ponte (no servidor da Alice) busca por HTTPS de saída. Requer ALICE_API_KEY.
 */
export function bridgeMode(env) {
  return !env.OPENCLAW_BASE_URL && !!env.ALICE_API_KEY;
}

export function chatConfigured(env) {
  return bridgeMode(env) || !!(env.OPENCLAW_BASE_URL && env.OPENCLAW_GATEWAY_TOKEN);
}

export function hooksConfigured(env) {
  return bridgeMode(env) || !!(env.OPENCLAW_BASE_URL && env.OPENCLAW_HOOKS_TOKEN);
}

export async function bridgeStatus(env) {
  const { lastSeen } = await fila(env).status();
  return { lastSeen, online: !!lastSeen && Date.now() - lastSeen < BRIDGE_ONLINE_MS };
}

function base(env) {
  return env.OPENCLAW_BASE_URL.replace(/\/+$/, "");
}

function agentId(env) {
  return env.OPENCLAW_AGENT_ID || "main";
}

/** Cabeçalhos do Cloudflare Access (quando o gateway está atrás de um Cloudflare Tunnel protegido). */
function accessHeaders(env) {
  return env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET
    ? { "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET }
    : {};
}

/** Abre a conversa em streaming. Devolve a Response do gateway (SSE) ou lança HttpError. */
export async function openChatStream(env, sessionKey, content) {
  if (!chatConfigured(env)) throw new HttpError(503, "a conversa ainda não foi ligada (falta configurar o OpenClaw)");
  let res;
  try {
    res = await fetch(`${base(env)}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENCLAW_GATEWAY_TOKEN}`,
        "x-openclaw-session-key": sessionKey,
        ...accessHeaders(env),
      },
      body: JSON.stringify({
        model: `openclaw/${agentId(env)}`,
        stream: true,
        messages: [{ role: "user", content }],
      }),
    });
  } catch (err) {
    throw new HttpError(502, `não consegui falar com a Alice: ${err}`);
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    const hint =
      res.status === 409
        ? "a sessão dessa conversa foi arquivada no OpenClaw — clique em “Nova conversa”"
        : `o gateway respondeu ${res.status}`;
    throw new HttpError(502, `${hint}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return res;
}

/** Lê um stream SSE no formato OpenAI e devolve o texto completo da resposta. */
export async function collectSseText(stream) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let text = "";
  let error = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const obj = JSON.parse(data);
        if (obj.error) error = obj.error.message || JSON.stringify(obj.error);
        const delta = obj.choices?.[0]?.delta?.content;
        if (typeof delta === "string") text += delta;
      } catch {
        /* linha incompleta ou não-JSON: ignora */
      }
    }
  }
  return { text, error };
}

/** Dispara uma tarefa assíncrona. Devolve { runId }. */
export async function submitTask(env, task, message) {
  if (!hooksConfigured(env)) throw new HttpError(503, "o envio de tarefas ainda não foi ligado (falta configurar os hooks do OpenClaw)");
  const res = await fetch(`${base(env)}/hooks/agent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENCLAW_HOOKS_TOKEN}`,
      "Idempotency-Key": `${task.id}-${task.attempts || 1}`, // reenvio usa chave nova
      ...accessHeaders(env),
    },
    body: JSON.stringify({
      message,
      name: `Torre: ${task.title}`.slice(0, 100),
      agentId: agentId(env),
      deliver: false,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new HttpError(502, `o gateway recusou a tarefa (HTTP ${res.status}${body.error ? `: ${body.error}` : ""})`);
  }
  return { runId: body.runId || null };
}

/** Teste de conexão (lista os agentes); usado pelo painel para mostrar se a ponte está de pé. */
export async function ping(env) {
  if (!chatConfigured(env)) return { ok: false, reason: "não configurado" };
  if (bridgeMode(env)) {
    const st = await bridgeStatus(env);
    if (st.online) return { ok: true, mode: "ponte" };
    return {
      ok: false,
      mode: "ponte",
      reason: st.lastSeen ? `ponte sem sinal desde ${new Date(st.lastSeen).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}` : "a ponte ainda não foi instalada no servidor da Alice",
    };
  }
  try {
    const res = await fetch(`${base(env)}/v1/models`, {
      headers: { authorization: `Bearer ${env.OPENCLAW_GATEWAY_TOKEN}`, ...accessHeaders(env) },
    });
    return res.ok ? { ok: true, mode: "direto" } : { ok: false, mode: "direto", reason: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: String(err).slice(0, 120) };
  }
}
