/**
 * Torre de Controle — backend (Cloudflare Worker)
 *
 * Painel (Authorization: Bearer <token do /api/login>):
 *   POST /api/login                         { username, password } -> { token, username, expiresAt }
 *   GET  /api/session                       -> { username }
 *   GET  /api/health                        -> o que está configurado/conectado (OpenClaw, e-mail)
 *   GET  /api/routines                      -> rotinas com estado e última execução
 *   POST /api/routines/save                 { id, name, schedule, description, note, prompt, steps, checks, defaultOn }
 *   POST /api/routines/import               { routines: [...] } (cria ou substitui por id)
 *   POST /api/routines/:id/state            { on: true|false }
 *   POST /api/routines/:id/delete
 *   GET  /api/routines/pending              propostas da Alice aguardando aprovação
 *   POST /api/routines/pending/:pid/approve | /reject
 *   GET  /api/audit?limit=&cursor=          linha do tempo (auditoria)
 *   GET  /api/audit/:id                     evento completo
 *   POST /api/test-email                    manda um e-mail de teste
 *   POST /api/files                         corpo = arquivo cru; X-File-Name; até 20 MB -> { id, ... }
 *   GET  /api/chat                          histórico da conversa do usuário
 *   POST /api/chat                          { message, files: [ids] } -> stream SSE da resposta da Alice
 *   POST /api/chat/reset                    começa uma conversa nova
 *   GET  /api/tasks | GET /api/tasks/:id
 *   POST /api/tasks                         { title, description, files: [ids], routineId? }
 *   POST /api/tasks/:id/resend
 *
 * Público:
 *   GET  /api/routines/status               [{ id, on }] — a Alice consulta antes de rodar
 *   GET  /api/files/:id?exp=&sig=           download por link assinado
 *
 * Alice (cabeçalho X-Agent-Key = ALICE_API_KEY):
 *   GET  /api/agent/routines                definições completas + estado
 *   POST /api/agent/routines                propõe rotina nova (vai para aprovação)
 *   POST /api/agent/routines/:id            propõe edição de rotina criada por ela
 *   POST /api/agent/runs                    reporta execução { routineId?, title?, status, summary, details? }
 *   GET  /api/agent/tasks/:id               detalhes da tarefa (com links dos arquivos)
 *   POST /api/agent/tasks/:id               atualiza tarefa { status: running|done|error, result?, files? }
 *   POST /api/agent/files                   envia arquivo de resultado (mesmo formato do /api/files)
 *
 * Segredos: JWT_SECRET, USERS_JSON, ALICE_API_KEY, OPENCLAW_BASE_URL, OPENCLAW_GATEWAY_TOKEN,
 *   OPENCLAW_HOOKS_TOKEN, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, MAIL_WEBHOOK_URL,
 *   MAIL_WEBHOOK_SECRET, AUDIT_EMAIL_TO, ROUTINE_WEBHOOK_URL (opcional). Detalhes em setup/CONFIGURAR.md.
 */
import { HttpError, json, corsHeaders, withHeaders, readJson, isValidSlug, clip, spNow } from "./lib/util.js";
import { login, makeSessionToken, requireUser, requireAgent, SESSION_TTL_SECONDS } from "./lib/auth.js";
import { record, listAudit, getAuditEvent } from "./lib/audit.js";
import { sendMail, mailConfigured } from "./lib/mail.js";
import {
  sanitizeRoutineFields,
  getRoutineDefs,
  setRoutineDefs,
  getState,
  setState,
  setLastRun,
  listRoutines,
  requireRoutine,
  nextOrder,
  getPending,
  setPending,
  newProposalId,
  newTaskId,
  saveTask,
  getTask,
  listTasks,
} from "./lib/store.js";
import { storeUpload, serveSignedFile, resolveFiles, fmtSize } from "./lib/files.js";
import { openChatStream, collectSseText, submitTask, chatConfigured, hooksConfigured, ping } from "./lib/openclaw.js";
import { scheduled } from "./cron.js";
import { migrateLegacy } from "./lib/migrate.js";

const RUN_STATUSES = ["started", "ok", "error", "skipped", "wait"];
const CHAT_HISTORY_MAX = 100;

// ------------------------------------------------------------------ helpers

function apiBase(request, env) {
  return (env.API_BASE_URL || new URL(request.url).origin).replace(/\/+$/, "");
}

function filesBlock(files) {
  if (!files.length) return "";
  return (
    "\n\nArquivos anexados (links válidos por 72h — baixe com: curl -L -o \"<nome>\" \"<link>\"):\n" +
    files.map((f) => `- ${f.name} (${fmtSize(f.size)}): ${f.url}`).join("\n")
  );
}

function stripUrls(files) {
  return files.map(({ url, ...rest }) => rest);
}

async function withFreshUrls(env, base, files) {
  return resolveFiles(env, base, (files || []).map((f) => f.id)).catch(() =>
    (files || []).map((f) => ({ ...f, url: null, expired: true }))
  );
}

function taskMessage(task, files, base) {
  return (
    `[Torre de Controle] Nova tarefa solicitada por ${task.createdBy}.\n` +
    `ID da tarefa: ${task.id}\n` +
    (task.routineName ? `Rotina relacionada: ${task.routineName} (${task.routineId})\n` : "") +
    `\nTítulo: ${task.title}\n\nO que fazer:\n${task.description}` +
    filesBlock(files) +
    `\n\nSiga a skill "torre-de-controle":\n` +
    `1. Ao começar: POST ${base}/api/agent/tasks/${task.id} com {"status":"running"}.\n` +
    `2. Ao terminar: POST ${base}/api/agent/tasks/${task.id} com {"status":"done","result":"<resumo em markdown>","files":["<ids enviados em /api/agent/files>"]}.\n` +
    `3. Se não conseguir: {"status":"error","result":"<o que deu errado e o que falta>"}.\n` +
    `Use o cabeçalho X-Agent-Key.`
  );
}

// ------------------------------------------------------------------ rotas do painel

async function routeUser(request, env, ctx, url, path, method) {
  const user = await requireUser(request, env);
  const base = apiBase(request, env);
  let m;

  if (path === "/api/session" && method === "GET") return json({ username: user });

  if (path === "/api/health" && method === "GET") {
    const conn = await ping(env);
    return json({
      chat: { configured: chatConfigured(env), online: conn.ok, reason: conn.reason || null },
      tasks: { configured: hooksConfigured(env) },
      mail: { configured: mailConfigured(env) },
      agentKey: { configured: !!env.ALICE_API_KEY },
      routineWebhook: { configured: !!env.ROUTINE_WEBHOOK_URL },
    });
  }

  // ----- rotinas
  if (path === "/api/routines" && method === "GET") {
    await migrateLegacy(env);
    return json({ routines: await listRoutines(env) });
  }

  if (path === "/api/routines/save" && method === "POST") {
    const body = await readJson(request);
    if (!isValidSlug(body.id)) throw new HttpError(400, "id inválido — use letras minúsculas, números e hífen (ex: revisar-boletos)");
    const fields = sanitizeRoutineFields(body);
    const defs = await getRoutineDefs(env);
    const existing = defs[body.id];
    const now = new Date().toISOString();
    defs[body.id] = existing
      ? { ...existing, ...fields, id: body.id, updatedBy: user, updatedAt: now }
      : { ...fields, id: body.id, order: nextOrder(defs), createdBy: user, createdAt: now };
    await setRoutineDefs(env, defs);
    await record(env, ctx, {
      type: existing ? "routine_edit" : "routine_create",
      actor: user,
      routineId: body.id,
      routineName: fields.name,
      summary: `${existing ? "Editou" : "Criou"} a rotina "${fields.name}"`,
    });
    return json({ ok: true, routine: defs[body.id] });
  }

  if (path === "/api/routines/import" && method === "POST") {
    const body = await readJson(request);
    await migrateLegacy(env);
    const list = Array.isArray(body) ? body : body.routines;
    if (!Array.isArray(list) || !list.length || list.length > 100) throw new HttpError(400, "envie { routines: [...] } com até 100 rotinas");
    const defs = await getRoutineDefs(env);
    const now = new Date().toISOString();
    const ids = [];
    for (const r of list) {
      if (!isValidSlug(r.id)) throw new HttpError(400, `id inválido: ${r.id}`);
      const fields = sanitizeRoutineFields(r);
      defs[r.id] = {
        ...(defs[r.id] || { order: nextOrder(defs), createdAt: now }),
        ...fields,
        id: r.id,
        createdBy: defs[r.id]?.createdBy || (r.createdBy === "alice" ? "alice" : user),
        updatedBy: user,
        updatedAt: now,
      };
      ids.push(r.id);
    }
    await setRoutineDefs(env, defs);
    await record(env, ctx, { type: "routine_import", actor: user, summary: `Importou ${ids.length} rotina(s): ${clip(ids.join(", "), 300)}` });
    return json({ ok: true, imported: ids });
  }

  if ((m = path.match(/^\/api\/routines\/([a-z0-9-]+)\/state$/)) && method === "POST") {
    const body = await readJson(request);
    if (typeof body.on !== "boolean") throw new HttpError(400, "envie { on: true } ou { on: false }");
    const { routine } = await requireRoutine(env, m[1]);
    const before = await getState(env, routine.id, routine.defaultOn);
    await setState(env, routine.id, body.on);

    let bridged = false;
    let bridgeError = null;
    if (env.ROUTINE_WEBHOOK_URL) {
      try {
        const res = await fetch(env.ROUTINE_WEBHOOK_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ routineId: routine.id, routineName: routine.name, action: body.on ? "enable" : "disable", by: user, at: new Date().toISOString() }),
        });
        bridged = res.ok;
        if (!res.ok) bridgeError = `HTTP ${res.status}`;
      } catch (err) {
        bridgeError = String(err);
      }
    }
    await record(
      env,
      ctx,
      {
        type: body.on ? "routine_enable" : "routine_disable",
        severity: bridgeError ? "warn" : "info",
        actor: user,
        routineId: routine.id,
        routineName: routine.name,
        summary:
          `${body.on ? "Ligou" : "Desligou"} a rotina "${routine.name}"` +
          (before === body.on ? " (já estava assim)" : "") +
          (bridgeError ? ` — falha ao avisar o webhook: ${bridgeError}` : ""),
      },
      { alert: !!bridgeError }
    );
    return json({ ok: true, id: routine.id, on: body.on, bridged, bridgeError });
  }

  if ((m = path.match(/^\/api\/routines\/([a-z0-9-]+)\/delete$/)) && method === "POST") {
    const { defs, routine } = await requireRoutine(env, m[1]);
    delete defs[routine.id];
    await setRoutineDefs(env, defs);
    await env.ROTINAS.delete(`state:${routine.id}`);
    await record(env, ctx, { type: "routine_delete", severity: "warn", actor: user, routineId: routine.id, routineName: routine.name, summary: `Excluiu a rotina "${routine.name}"` });
    return json({ ok: true });
  }

  // ----- propostas da Alice
  if (path === "/api/routines/pending" && method === "GET") {
    const pending = await getPending(env);
    const defs = await getRoutineDefs(env);
    return json({ pending: pending.map((p) => ({ ...p, current: p.type === "edit" ? defs[p.routineId] || null : null })) });
  }

  if ((m = path.match(/^\/api\/routines\/pending\/([\w-]+)\/(approve|reject)$/)) && method === "POST") {
    const [, proposalId, action] = m;
    const pending = await getPending(env);
    const idx = pending.findIndex((p) => p.proposalId === proposalId);
    if (idx === -1) throw new HttpError(404, "proposta não encontrada");
    const proposal = pending[idx];
    const defs = await getRoutineDefs(env);
    const now = new Date().toISOString();
    let name = proposal.payload?.name || defs[proposal.routineId]?.name || proposal.routineId;

    if (action === "approve") {
      if (proposal.type === "create") {
        if (defs[proposal.routineId]) throw new HttpError(409, "já existe uma rotina com esse id — rejeite esta proposta");
        defs[proposal.routineId] = { ...proposal.payload, order: nextOrder(defs), createdBy: "alice", createdAt: proposal.proposedAt, approvedBy: user, approvedAt: now };
      } else {
        const existing = defs[proposal.routineId];
        if (!existing) throw new HttpError(404, "a rotina original não existe mais — rejeite esta proposta");
        defs[proposal.routineId] = { ...existing, ...proposal.payload, updatedBy: user, updatedAt: now };
        name = defs[proposal.routineId].name;
      }
      await setRoutineDefs(env, defs);
    }
    pending.splice(idx, 1);
    await setPending(env, pending);
    await record(env, ctx, {
      type: `${action}_${proposal.type}`,
      actor: user,
      routineId: proposal.routineId,
      routineName: name,
      summary: `${action === "approve" ? "Aprovou" : "Rejeitou"} ${proposal.type === "create" ? "a rotina nova" : "a edição da rotina"} "${name}" proposta pela Alice`,
    });
    return json({ ok: true });
  }

  // ----- auditoria
  if (path === "/api/audit" && method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
    return json(await listAudit(env, { limit, cursor: url.searchParams.get("cursor") || undefined }));
  }
  if ((m = path.match(/^\/api\/audit\/([\w:-]+)$/)) && method === "GET") {
    const ev = await getAuditEvent(env, m[1]);
    if (!ev) throw new HttpError(404, "evento não encontrado");
    return json(ev);
  }

  if (path === "/api/test-email" && method === "POST") {
    if (!mailConfigured(env)) throw new HttpError(503, "e-mail ainda não configurado (MAIL_WEBHOOK_URL, MAIL_WEBHOOK_SECRET, AUDIT_EMAIL_TO)");
    const res = await sendMail(env, "[Torre] E-mail de teste", `<p>Teste enviado por ${user} pela Torre de Controle. Se chegou, os alertas e o resumo diário vão chegar também.</p>`);
    if (!res.ok) throw new HttpError(502, `falha no envio: ${res.error}`);
    return json({ ok: true });
  }

  // ----- arquivos
  if (path === "/api/files" && method === "POST") {
    const info = await storeUpload(request, env, user);
    return json({ ok: true, file: info }, 201);
  }

  // ----- conversa
  if (path === "/api/chat" && method === "GET") {
    return json({ messages: (await env.ROTINAS.get(`chat:${user}`, "json")) || [] });
  }

  if (path === "/api/chat/reset" && method === "POST") {
    const n = Number((await env.ROTINAS.get(`chatsession:${user}`)) || 0) + 1;
    await env.ROTINAS.put(`chatsession:${user}`, String(n));
    await env.ROTINAS.put(`chat:${user}`, "[]");
    await record(env, ctx, { type: "chat_reset", actor: user, summary: "Começou uma conversa nova com a Alice" });
    return json({ ok: true });
  }

  if (path === "/api/chat" && method === "POST") {
    const body = await readJson(request);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) throw new HttpError(400, "escreva uma mensagem");
    if (message.length > 8000) throw new HttpError(400, "mensagem longa demais (máx. 8000 caracteres)");
    const files = await resolveFiles(env, base, body.files);
    const n = Number((await env.ROTINAS.get(`chatsession:${user}`)) || 0);
    const sessionKey = `torre-${user}-${n}`;
    const content = `[Mensagem de ${user} pela Torre de Controle]\n\n${message}${filesBlock(files)}`;

    const upstream = await openChatStream(env, sessionKey, content);

    const history = (await env.ROTINAS.get(`chat:${user}`, "json")) || [];
    history.push({ role: "user", text: message, files: stripUrls(files), at: new Date().toISOString() });

    const [toClient, toStore] = upstream.body.tee();
    ctx.waitUntil(
      (async () => {
        const { text, error } = await collectSseText(toStore);
        history.push({ role: "assistant", text: text || "", error: error || undefined, at: new Date().toISOString() });
        await env.ROTINAS.put(`chat:${user}`, JSON.stringify(history.slice(-CHAT_HISTORY_MAX)));
        if (files.length || error) {
          await record(env, null, {
            type: "chat_message",
            severity: error ? "warn" : "info",
            actor: user,
            summary: error ? `Erro na conversa com a Alice: ${clip(error, 200)}` : `Enviou ${files.length} arquivo(s) para a Alice pela conversa`,
          });
        }
      })()
    );
    return new Response(toClient, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    });
  }

  // ----- tarefas
  if (path === "/api/tasks" && method === "GET") return json({ tasks: await listTasks(env, 50) });

  if ((m = path.match(/^\/api\/tasks\/([\w-]+)$/)) && method === "GET") {
    const task = await getTask(env, m[1]);
    if (!task) throw new HttpError(404, "tarefa não encontrada");
    return json({
      ...task,
      files: await withFreshUrls(env, base, task.files),
      resultFiles: await withFreshUrls(env, base, task.resultFiles),
    });
  }

  if (path === "/api/tasks" && method === "POST") {
    const body = await readJson(request);
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (!title || title.length > 150) throw new HttpError(400, "dê um título de até 150 caracteres");
    if (!description || description.length > 10000) throw new HttpError(400, "descreva a atividade (até 10.000 caracteres)");
    const files = await resolveFiles(env, base, body.files);
    let routine = null;
    if (body.routineId) routine = (await requireRoutine(env, body.routineId)).routine;

    const now = new Date().toISOString();
    const task = {
      id: newTaskId(),
      title,
      description,
      routineId: routine?.id,
      routineName: routine?.name,
      files: stripUrls(files),
      status: "queued",
      createdBy: user,
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, status: "queued", by: user }],
    };
    return json(await dispatchTask(env, ctx, task, files, base, user), 201);
  }

  if ((m = path.match(/^\/api\/tasks\/([\w-]+)\/resend$/)) && method === "POST") {
    const task = await getTask(env, m[1]);
    if (!task) throw new HttpError(404, "tarefa não encontrada");
    if (["done", "running"].includes(task.status)) throw new HttpError(409, "a tarefa já está em andamento ou concluída");
    const files = await resolveFiles(env, base, task.files.map((f) => f.id));
    return json(await dispatchTask(env, ctx, task, files, base, user));
  }

  throw new HttpError(404, "rota não encontrada");
}

async function dispatchTask(env, ctx, task, files, base, user) {
  let sendError = null;
  task.attempts = (task.attempts || 0) + 1;
  try {
    const { runId } = await submitTask(env, task, taskMessage(task, files, base));
    task.runId = runId;
    task.status = "sent";
  } catch (err) {
    sendError = err.message || String(err);
    task.status = "send_failed";
    task.error = sendError;
  }
  task.updatedAt = new Date().toISOString();
  task.history.push({ at: task.updatedAt, status: task.status, by: user, note: sendError || undefined });
  await saveTask(env, task);
  await record(
    env,
    ctx,
    {
      type: sendError ? "task_send_failed" : "task_sent",
      severity: sendError ? "error" : "info",
      actor: user,
      taskId: task.id,
      routineId: task.routineId,
      routineName: task.routineName,
      summary: sendError
        ? `Não consegui enviar a tarefa "${task.title}" para a Alice: ${clip(sendError, 200)}`
        : `Pediu à Alice: "${task.title}"${task.files.length ? ` (${task.files.length} arquivo(s))` : ""}`,
    },
    { alert: !!sendError }
  );
  return { ok: !sendError, task: { ...task, files }, error: sendError };
}

// ------------------------------------------------------------------ rotas da Alice

async function routeAgent(request, env, ctx, url, path, method) {
  const actor = requireAgent(request, env);
  const base = apiBase(request, env);
  let m;

  if (path === "/api/agent/routines" && method === "GET") {
    return json({ routines: await listRoutines(env) });
  }

  if (path === "/api/agent/routines" && method === "POST") {
    const body = await readJson(request);
    if (!isValidSlug(body.id)) throw new HttpError(400, "id inválido — use letras minúsculas, números e hífen (ex: revisar-boletos-atraso)");
    const fields = sanitizeRoutineFields(body);
    const defs = await getRoutineDefs(env);
    if (defs[body.id]) throw new HttpError(409, `já existe uma rotina com esse id — para alterá-la use POST /api/agent/routines/${body.id}`);
    const pending = await getPending(env);
    if (pending.some((p) => p.type === "create" && p.routineId === body.id)) throw new HttpError(409, "já existe uma proposta pendente com esse id");
    const proposal = { proposalId: newProposalId(), type: "create", routineId: body.id, payload: { ...fields, id: body.id }, proposedBy: actor, proposedAt: new Date().toISOString() };
    pending.unshift(proposal);
    await setPending(env, pending);
    await record(env, ctx, { type: "propose_create", actor, routineId: body.id, routineName: fields.name, summary: `Alice propôs a rotina nova "${fields.name}" (aguardando aprovação)` });
    return json({ ok: true, proposalId: proposal.proposalId, status: "pending_approval" }, 201);
  }

  if ((m = path.match(/^\/api\/agent\/routines\/([a-z0-9-]+)$/)) && method === "POST") {
    const defs = await getRoutineDefs(env);
    const current = defs[m[1]];
    if (!current || current.createdBy !== "alice") {
      throw new HttpError(404, "só é possível propor edição de rotinas criadas pela Alice e já aprovadas");
    }
    const changes = sanitizeRoutineFields(await readJson(request), { partial: true });
    if (!Object.keys(changes).length) throw new HttpError(400, "nenhum campo reconhecido foi enviado para alterar");
    const pending = await getPending(env);
    const proposal = { proposalId: newProposalId(), type: "edit", routineId: current.id, payload: changes, proposedBy: actor, proposedAt: new Date().toISOString() };
    pending.unshift(proposal);
    await setPending(env, pending);
    await record(env, ctx, { type: "propose_edit", actor, routineId: current.id, routineName: current.name, summary: `Alice propôs alterar a rotina "${current.name}" (aguardando aprovação)` });
    return json({ ok: true, proposalId: proposal.proposalId, status: "pending_approval" }, 201);
  }

  if (path === "/api/agent/runs" && method === "POST") {
    const body = await readJson(request);
    if (!RUN_STATUSES.includes(body.status)) throw new HttpError(400, `status precisa ser um de: ${RUN_STATUSES.join(", ")}`);
    const summary = clip(typeof body.summary === "string" ? body.summary : "", 1000);
    const details = clip(typeof body.details === "string" ? body.details : "", 20000);
    const at = new Date().toISOString();

    let routine = null;
    let on = null;
    if (body.routineId) {
      routine = (await requireRoutine(env, body.routineId)).routine;
      on = await getState(env, routine.id, routine.defaultOn);
    }
    const label = routine ? routine.name : clip(body.title || "Atividade avulsa", 150);

    if (routine) {
      await setLastRun(env, routine.id, { status: body.status, summary, at });
      if (["ok", "skipped", "error"].includes(body.status)) {
        await env.ROTINAS.put(`runday:${routine.id}:${spNow().date}`, body.status, { expirationTtl: 60 * 60 * 72 });
      }
    }

    const ranWhileOff = routine && on === false && ["started", "ok"].includes(body.status);
    const severity = body.status === "error" ? "error" : ranWhileOff ? "warn" : "info";
    const statusLabel = { started: "iniciou", ok: "concluiu", error: "falhou", skipped: "pulou", wait: "aguardando" }[body.status];
    await record(
      env,
      ctx,
      {
        type: `run_${body.status}`,
        severity,
        actor,
        routineId: routine?.id,
        routineName: label,
        summary: `${label}: ${statusLabel}${summary ? ` — ${summary}` : ""}${ranWhileOff ? " (ATENÇÃO: a rotina está DESLIGADA na Torre)" : ""}`,
        details: details || undefined,
      },
      { alert: severity !== "info" }
    );
    return json({ ok: true, routineOn: on });
  }

  if ((m = path.match(/^\/api\/agent\/tasks\/([\w-]+)$/))) {
    const task = await getTask(env, m[1]);
    if (!task) throw new HttpError(404, "tarefa não encontrada");

    if (method === "GET") {
      return json({ ...task, files: await withFreshUrls(env, base, task.files) });
    }
    if (method === "POST") {
      const body = await readJson(request);
      if (!["running", "done", "error"].includes(body.status)) throw new HttpError(400, "status precisa ser running, done ou error");
      const result = typeof body.result === "string" ? clip(body.result, 20000) : undefined;
      const resultFiles = body.files ? stripUrls(await resolveFiles(env, base, body.files)) : undefined;
      const now = new Date().toISOString();
      task.status = body.status;
      task.updatedAt = now;
      if (result !== undefined) task.result = result;
      if (resultFiles) task.resultFiles = resultFiles;
      if (body.status !== "running") task.finishedAt = now;
      task.history.push({ at: now, status: body.status, by: actor });
      await saveTask(env, task);
      if (body.status !== "running") {
        await record(
          env,
          ctx,
          {
            type: `task_${body.status}`,
            severity: body.status === "error" ? "error" : "info",
            actor,
            taskId: task.id,
            routineId: task.routineId,
            routineName: task.routineName,
            summary: `Tarefa "${task.title}" ${body.status === "done" ? "concluída" : "falhou"}${result ? ` — ${clip(result.replace(/\s+/g, " "), 200)}` : ""}`,
            details: result,
          },
          { alert: body.status === "error" }
        );
      }
      return json({ ok: true });
    }
  }

  if (path === "/api/agent/files" && method === "POST") {
    const info = await storeUpload(request, env, actor);
    return json({ ok: true, file: info }, 201);
  }

  throw new HttpError(404, "rota não encontrada");
}

// ------------------------------------------------------------------ entrada

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/login" && method === "POST") {
    const body = await readJson(request);
    const username = await login(env, body.username, body.password, (u) =>
      record(env, ctx, { type: "login_locked", severity: "warn", actor: "torre", summary: `Login de "${clip(u, 40)}" bloqueado por 15 min após 5 senhas erradas` }, { alert: true })
    );
    await record(env, ctx, { type: "login", actor: username, summary: `${username} entrou na Torre` });
    return json({ token: await makeSessionToken(env, username), username, expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000 });
  }

  if (path === "/api/routines/status" && method === "GET") {
    await migrateLegacy(env);
    const routines = await listRoutines(env);
    return json(routines.map((r) => ({ id: r.id, on: r.on })));
  }

  let m;
  if ((m = path.match(/^\/api\/files\/(f[0-9a-z]+)$/)) && method === "GET") {
    return serveSignedFile(env, m[1], url);
  }

  if (path.startsWith("/api/agent/")) return routeAgent(request, env, ctx, url, path, method);
  if (path.startsWith("/api/")) return routeUser(request, env, ctx, url, path, method);
  throw new HttpError(404, "rota não encontrada");
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      return withHeaders(await handle(request, env, ctx), cors);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return json({ error: err instanceof HttpError ? err.message : "erro interno — veja os logs do Worker" }, status, cors);
    }
  },
  scheduled,
};
