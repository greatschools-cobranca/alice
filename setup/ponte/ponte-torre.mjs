#!/usr/bin/env node
/**
 * Ponte de saída Torre de Controle → Alice (OpenClaw)
 *
 * Roda no MESMO servidor do OpenClaw. Só faz conexões de SAÍDA:
 *   - HTTPS para a Torre (pergunta a cada poucos segundos se há mensagem/tarefa nova);
 *   - HTTP para o gateway em localhost (127.0.0.1:18789).
 * Não abre porta, não mexe em rede/VPN/firewall e não consome tokens enquanto não há pedidos.
 *
 * Requer Node.js 18+ (o OpenClaw já usa Node 22). Sem dependências.
 *
 * Configuração: arquivo ponte.env na mesma pasta (ou variáveis de ambiente):
 *   TORRE_API_BASE=https://torre-de-controle-api.alice-fontes.workers.dev
 *   TORRE_AGENT_KEY=<ALICE_API_KEY>
 *   OPENCLAW_URL=http://127.0.0.1:18789
 *   OPENCLAW_GATEWAY_TOKEN=<token ou senha do gateway>
 *   OPENCLAW_HOOKS_TOKEN=<hooks.token>
 *   OPENCLAW_AGENT_ID=main
 *
 * Uso:
 *   node ponte-torre.mjs --teste     confere a configuração e sai
 *   node ponte-torre.mjs             roda (use o serviço systemd em setup/ponte/README.md)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "1.0.0";
const here = path.dirname(fileURLToPath(import.meta.url));

// ---------- configuração ----------
function loadEnvFile(file) {
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return; // sem arquivo (ou sem permissão): usa só as variáveis de ambiente, ex.: EnvironmentFile do systemd
  }
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(path.join(here, "ponte.env"));

const cfg = {
  torre: (process.env.TORRE_API_BASE || "").replace(/\/+$/, ""),
  agentKey: process.env.TORRE_AGENT_KEY || "",
  gateway: (process.env.OPENCLAW_URL || "http://127.0.0.1:18789").replace(/\/+$/, ""),
  gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN || "",
  hooksToken: process.env.OPENCLAW_HOOKS_TOKEN || "",
  agentId: process.env.OPENCLAW_AGENT_ID || "main",
  pollMs: Math.max(1000, Number(process.env.POLL_MS) || 3000),
  maxConcurrent: Math.max(1, Number(process.env.MAX_CONCURRENT) || 2),
  chatTimeoutMs: Math.max(60000, Number(process.env.CHAT_TIMEOUT_MS) || 10 * 60 * 1000),
};

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function checkConfig() {
  const missing = [];
  if (!cfg.torre) missing.push("TORRE_API_BASE");
  if (!cfg.agentKey) missing.push("TORRE_AGENT_KEY");
  if (!cfg.gatewayToken) missing.push("OPENCLAW_GATEWAY_TOKEN");
  if (!cfg.hooksToken) missing.push("OPENCLAW_HOOKS_TOKEN");
  if (missing.length) {
    console.error(`Faltam configurações: ${missing.join(", ")} (arquivo ponte.env ou variáveis de ambiente).`);
    process.exit(2);
  }
  if (!/^https:\/\//.test(cfg.torre) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(cfg.torre)) {
    console.error("TORRE_API_BASE precisa começar com https://");
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- chamadas à Torre ----------
async function torre(pathname, opts = {}) {
  const res = await fetch(cfg.torre + pathname, {
    method: opts.body !== undefined ? "POST" : "GET",
    headers: { "X-Agent-Key": cfg.agentKey, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Torre respondeu ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function finishJob(id, data) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await torre(`/api/agent/bridge/jobs/${id}/done`, { body: data });
      return;
    } catch (err) {
      log(`[${id}] falha ao avisar a Torre (tentativa ${attempt}/5): ${err.message}`);
      await sleep(2000 * attempt);
    }
  }
}

// ---------- conversa ----------
async function handleChat(job) {
  const { sessionKey, content } = job.payload;
  let text = "";
  let lastSent = 0;
  let lastSentText = "";
  const pushProgress = async (force = false) => {
    if (text === lastSentText) return;
    if (!force && Date.now() - lastSent < 1500) return;
    lastSent = Date.now();
    lastSentText = text;
    await torre(`/api/agent/bridge/jobs/${job.id}/progress`, { body: { text } }).catch(() => {});
  };

  try {
    const res = await fetch(`${cfg.gateway}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.gatewayToken}`,
        "x-openclaw-session-key": sessionKey,
      },
      body: JSON.stringify({ model: `openclaw/${cfg.agentId}`, stream: true, messages: [{ role: "user", content }] }),
      signal: AbortSignal.timeout(cfg.chatTimeoutMs),
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      const hint = res.status === 409 ? "sessão arquivada no OpenClaw — clique em “Nova conversa”" : `gateway respondeu ${res.status}`;
      throw new Error(`${hint}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const decoder = new TextDecoder();
    let buf = "";
    let streamError = null;
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const obj = JSON.parse(data);
          if (obj.error) streamError = obj.error.message || "erro na execução da Alice";
          const delta = obj.choices?.[0]?.delta?.content;
          if (typeof delta === "string") text += delta;
        } catch {
          /* linha parcial */
        }
      }
      pushProgress();
    }
    await pushProgress(true);
    await finishJob(job.id, streamError ? { text, error: streamError } : { text });
    log(`[${job.id}] conversa respondida (${text.length} caracteres)${streamError ? " com erro" : ""}`);
  } catch (err) {
    const msg = err.name === "TimeoutError" ? "a Alice demorou demais para responder" : err.message;
    await finishJob(job.id, { text, error: msg });
    log(`[${job.id}] conversa falhou: ${msg}`);
  }
}

// ---------- tarefas ----------
async function handleTask(job) {
  const { message, name, idempotencyKey } = job.payload;
  try {
    const res = await fetch(`${cfg.gateway}/hooks/agent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.hooksToken}`,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ message, name, agentId: cfg.agentId, deliver: false }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) throw new Error(`gateway recusou a tarefa (HTTP ${res.status}${body.error ? `: ${body.error}` : ""})`);
    await finishJob(job.id, { runId: body.runId || null });
    log(`[${job.id}] tarefa entregue à Alice (run ${body.runId || "?"})`);
  } catch (err) {
    await finishJob(job.id, { error: err.message });
    log(`[${job.id}] tarefa NÃO entregue: ${err.message}`);
  }
}

// ---------- teste ----------
async function selfTest() {
  let ok = true;
  const step = async (label, fn) => {
    try {
      const info = await fn();
      console.log(`  OK    ${label}${info ? ` — ${info}` : ""}`);
    } catch (err) {
      ok = false;
      console.log(`  ERRO  ${label} — ${err.message}`);
    }
  };
  console.log(`Ponte Torre → Alice v${VERSION} · teste de configuração`);
  await step("Torre acessível e chave da Alice aceita", async () => {
    const r = await torre("/api/agent/routines");
    return `${r.routines.length} rotina(s) cadastrada(s)`;
  });
  await step("Gateway do OpenClaw em " + cfg.gateway + " (conversa)", async () => {
    const res = await fetch(`${cfg.gateway}/v1/models`, { headers: { authorization: `Bearer ${cfg.gatewayToken}` }, signal: AbortSignal.timeout(10000) });
    if (res.status === 404) throw new Error("endpoint não encontrado — habilite gateway.http.endpoints.chatCompletions");
    if (res.status === 401 || res.status === 403) throw new Error("token do gateway recusado");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return null;
  });
  await step("Hooks do OpenClaw (tarefas)", async () => {
    // Corpo vazio de propósito: 400 = hooks ligados e token aceito; 401 = token errado; 404 = hooks desligados.
    const res = await fetch(`${cfg.gateway}/hooks/agent`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.hooksToken}` },
      body: "{}",
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404) throw new Error("hooks desligados — habilite hooks.enabled");
    if (res.status === 401 || res.status === 403) throw new Error("hooks.token recusado");
    if (res.status !== 400 && !res.ok) throw new Error(`HTTP ${res.status}`);
    return null;
  });
  console.log(ok ? "\nTudo certo. Pode instalar o serviço." : "\nCorrija os itens com ERRO e rode o teste de novo.");
  process.exit(ok ? 0 : 1);
}

// ---------- laço principal ----------
let running = true;
let active = 0;

async function main() {
  checkConfig();
  if (process.argv.includes("--teste")) return selfTest();

  log(`Ponte Torre → Alice v${VERSION} iniciada · Torre ${cfg.torre} · gateway ${cfg.gateway} · consulta a cada ${cfg.pollMs} ms`);
  let backoff = cfg.pollMs;
  let lastError = "";
  while (running) {
    if (active >= cfg.maxConcurrent) {
      await sleep(500);
      continue;
    }
    try {
      const job = await torre("/api/agent/bridge/next");
      if (lastError) {
        log("conexão com a Torre restabelecida");
        lastError = "";
      }
      backoff = cfg.pollMs;
      if (!job) {
        await sleep(cfg.pollMs);
        continue;
      }
      log(`[${job.id}] novo pedido: ${job.type}`);
      active++;
      const handler = job.type === "chat" ? handleChat : job.type === "task" ? handleTask : null;
      (handler ? handler(job) : finishJob(job.id, { error: `tipo de pedido desconhecido: ${job.type}` })).finally(() => active--);
    } catch (err) {
      if (err.status === 401) {
        console.error("A Torre recusou a chave (TORRE_AGENT_KEY). Confira o valor e reinicie a ponte.");
        process.exit(3);
      }
      if (err.message !== lastError) log(`falha ao consultar a Torre: ${err.message} (tentando de novo)`);
      lastError = err.message;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (!running) process.exit(0);
    running = false;
    log(`encerrando (aguardando ${active} pedido(s) em andamento)…`);
    for (let i = 0; i < 60 && active > 0; i++) await sleep(500);
    process.exit(0);
  });
}

main();
