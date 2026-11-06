/** Torre de Controle: protocolo 2 de saída, restrito a rotinas cadastradas.
 * Painel autenticado: /api/routines, /api/tasks e /api/health.
 * Ponte exclusiva: /api/bridge/v2/{status,control,heartbeat,next,jobs/:id/result}.
 * X-Bridge-Key não é X-Agent-Key. Tokens do Gateway ficam somente na VPS.
 * Conversa livre e reenvio automático permanecem bloqueados.
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
import { chatConfigured, hooksConfigured, ping, bridgeMode } from "./lib/openclaw.js";
import { scheduled } from "./cron.js";
import { fila, Fila } from "./lib/fila.js";
import { syncQueuedTask } from "./lib/delivery.js";
import { routeBridge, controlSnapshot } from "./lib/bridge-api.js";
import { auditRequest } from "./lib/bridge-audit.js";
import { verifyGoogleIdToken, googleConfigured, passwordLoginEnabled, allowedDomain, emailCodeConfigured, isAdmin } from "./lib/google.js";
import { requestCode, verifyCode } from "./lib/emailcode.js";
import { routineVersion, BridgeError, bridgeValue } from "./lib/bridge-state.js";
import { migrateLegacy } from "./lib/migrate.js";

const RUN_STATUSES = ["started", "ok", "error", "skipped", "wait"];

// ------------------------------------------------------------------ helpers

function apiBase(request, env) {
  return (env.API_BASE_URL || new URL(request.url).origin).replace(/\/+$/, "");
}

function stripUrls(files) {
  return files.map(({ url, ...rest }) => rest);
}

async function withFreshUrls(env, base, files) {
  return resolveFiles(env, base, (files || []).map((f) => f.id)).catch(() =>
    (files || []).map((f) => ({ ...f, url: null, expired: true }))
  );
}

// ------------------------------------------------------------------ rotas do painel

async function routeUser(request, env, ctx, url, path, method) {
  const user = await requireUser(request, env);
  const base = apiBase(request, env);
  let m;

  if (path === "/api/session" && method === "GET") return json({ username: user, admin: isAdmin(env, user) });

  // Inclusão, edição, exclusão, importação e aprovação de propostas: só administradoras
  const ADMIN_ONLY = /^\/api\/routines\/(save|import|[a-z0-9-]+\/delete|pending\/[\w-]+\/(approve|reject))$/;
  if (method === "POST" && ADMIN_ONLY.test(path) && !isAdmin(env, user)) {
    await record(env, ctx, { type: "permission_denied", severity: "warn", actor: user, summary: `${user} tentou alterar rotinas sem permissão (${path.replace("/api/routines/", "")})` });
    throw new HttpError(403, "somente as administradoras da Torre podem incluir, editar ou excluir rotinas");
  }

  if (path === "/api/health" && method === "GET") {
    const conn = await ping(env);
    return json({
      chat: { configured: chatConfigured(env), online: conn.ok, reason: conn.reason || null, mode: conn.mode || null },
      tasks: { configured: hooksConfigured(env) },
      mail: { configured: mailConfigured(env) },
      agentKey: { configured: !!env.ALICE_API_KEY },
      routineWebhook: { configured: !!env.ROUTINE_WEBHOOK_URL },
      bridge: conn.bridge || { online: false, gateway: false, protocol: 2 },
      executionEnabled: hooksConfigured(env) && conn.ok && conn.bridge?.mode === "active",
      scope: "registered_routines_only",
    });
  }

  // ----- rotinas
  if (path === "/api/routines" && method === "GET") {
    await migrateLegacy(env);
    return json({ routines: await Promise.all((await listRoutines(env)).map(async r => ({ ...r, version: await routineVersion(r) }))) });
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
    return json({ messages: await fila(env).getHistory(user) });
  }

  if ((m = path.match(/^\/api\/chat\/jobs\/(j\w+)$/)) && method === "GET") {
    const job = await fila(env).get(m[1]);
    if (!job || job.user !== user) throw new HttpError(404, "mensagem não encontrada");
    return json({ status: job.status, text: job.text || "", error: job.error || null });
  }

  if (path === "/api/chat/reset" && method === "POST") {
    const n = Number((await env.ROTINAS.get(`chatsession:${user}`)) || 0) + 1;
    await env.ROTINAS.put(`chatsession:${user}`, String(n));
    await fila(env).resetHistory(user);
    await record(env, ctx, { type: "chat_reset", actor: user, summary: "Começou uma conversa nova com a Alice" });
    return json({ ok: true });
  }

  if (path === "/api/chat" && method === "POST") {
    throw new HttpError(403, "Conversa livre indisponível nesta etapa; use uma rotina cadastrada.");
  }

  // ----- tarefas
  if (path === "/api/tasks" && method === "GET") return json({ tasks: await listTasks(env, 50) });

  if ((m = path.match(/^\/api\/tasks\/([\w-]+)$/)) && method === "GET") {
    let task = await getTask(env, m[1]);
    if (!task) throw new HttpError(404, "tarefa não encontrada");
    task = await syncQueuedTask(env, ctx, task);
    return json({
      ...task,
      files: await withFreshUrls(env, base, task.files),
      resultFiles: await withFreshUrls(env, base, task.resultFiles),
    });
  }

  if (path === "/api/tasks" && method === "POST") {
    if (!bridgeMode(env) || env.ROUTINE_EXECUTION_ENABLED !== "true") throw new HttpError(503, "Execução pela ponte ainda não homologada.");
    const body = await readJson(request);
    if (Object.keys(body).some(k => !["requestId", "routineId", "version"].includes(k))) throw new HttpError(400, "Anexos, comandos e instruções livres não são aceitos nesta etapa.");
    const routine = (await requireRoutine(env, body.routineId)).routine;
    if (body.version !== await routineVersion(routine)) throw new HttpError(409, "A rotina mudou; atualize e revise novamente.");
    const now = new Date().toISOString();
    const task = { id: newTaskId(), title: `Executar: ${routine.name}`, routineId: routine.id, routineName: routine.name, files: [], status: "queued", createdBy: user, createdAt: now, updatedAt: now, history: [{ at: now, status: "queued", by: user }] };
    const job = bridgeValue(await fila(env).enqueueRoutine(user, body.requestId, routine.id, body.version, task));
    if (!job.duplicate) await auditRequest(env, ctx, user, task);
    return json({ ok: true, task: await getTask(env, job.taskId), duplicate: !!job.duplicate }, job.duplicate ? 200 : 201);
  }

  if ((m = path.match(/^\/api\/tasks\/([\w-]+)\/resend$/)) && method === "POST") {
    throw new HttpError(409, "Reenvio automático bloqueado. Confira a execução e registre um novo pedido apenas após reconciliação.");
  }

  throw new HttpError(404, "rota não encontrada");
}

// ------------------------------------------------------------------ rotas da Alice

async function routeAgent(request, env, ctx, url, path, method) {
  const actor = requireAgent(request, env);
  const base = apiBase(request, env);
  let m;

  if (path.startsWith("/api/agent/bridge/")) throw new HttpError(410, "Ponte antiga desativada; use protocolo 2 com chave própria.");

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

  // Mesmo nível de divulgação do status público anterior, acrescido de revisão opaca.
  // O gatilho não recebe a chave da ponte nem segredos do Gateway.
  if (path === "/api/routines/gate" && method === "GET") {
    const snapshot = await controlSnapshot(env);
    return json({ ...snapshot, routines: snapshot.routines.map(({ id, on, version }) => ({ id, on, version })) }, 200, { "Cache-Control": "no-store, max-age=0" });
  }

  // Qual forma de login o painel deve mostrar (público; o client id do Google não é segredo)
  if (path === "/api/auth/config" && method === "GET") {
    return json({
      google: googleConfigured(env) ? { clientId: env.GOOGLE_CLIENT_ID, domain: allowedDomain(env) } : null,
      emailCode: emailCodeConfigured(env) ? { domain: allowedDomain(env) } : null,
      password: passwordLoginEnabled(env),
    });
  }

  // Login por código no e-mail: 1) pedir o código
  if (path === "/api/login/code/request" && method === "POST") {
    if (!emailCodeConfigured(env)) throw new HttpError(503, "login por código ainda não configurado");
    const body = await readJson(request);
    const out = await requestCode(env, body.email);
    if (out.outcome === "denied") {
      await record(env, ctx, { type: "login_denied", severity: "warn", actor: "torre", summary: `Pedido de código de acesso para ${clip(out.email, 80)}, que não está na lista autorizada` });
    }
    // resposta igual nos dois casos: não revela quem está na lista
    return json({ ok: true, message: "Se o e-mail estiver autorizado, o código chega em instantes. Confira também a caixa de spam." });
  }

  // Login por código no e-mail: 2) conferir o código
  if (path === "/api/login/code/verify" && method === "POST") {
    if (!emailCodeConfigured(env)) throw new HttpError(503, "login por código ainda não configurado");
    const body = await readJson(request);
    const email = await verifyCode(env, body.email, body.code);
    await record(env, ctx, { type: "login", actor: email, summary: `${email} entrou na Torre (código por e-mail)` });
    return json({ token: await makeSessionToken(env, email, "email"), username: email, expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000 });
  }

  if (path === "/api/login/google" && method === "POST") {
    const body = await readJson(request);
    let who;
    try {
      who = await verifyGoogleIdToken(env, body.credential);
    } catch (err) {
      if (err.denied) {
        await record(env, ctx, { type: "login_denied", severity: "warn", actor: "torre", summary: `Tentativa de acesso de ${clip(err.denied, 80)}, que não está na lista autorizada` });
      }
      throw err;
    }
    await record(env, ctx, { type: "login", actor: who.email, summary: `${who.email} entrou na Torre (Google)` });
    return json({ token: await makeSessionToken(env, who.email, "google"), username: who.email, name: who.name, expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000 });
  }

  if (path === "/api/login" && method === "POST") {
    if (!passwordLoginEnabled(env)) throw new HttpError(403, "o acesso agora é pelo e-mail da empresa");
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

  if (path.startsWith("/api/bridge/v2/")) return routeBridge(request, env, path, method, ctx);
  if (path.startsWith("/api/agent/")) return routeAgent(request, env, ctx, url, path, method);
  if (path.startsWith("/api/")) return routeUser(request, env, ctx, url, path, method);
  throw new HttpError(404, "rota não encontrada");
}

export { Fila };

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      return withHeaders(await handle(request, env, ctx), cors);
    } catch (err) {
      const status = err instanceof HttpError || err instanceof BridgeError ? err.status : 500;
      if (status === 500) console.error("request_failed");
      return json({ error: err instanceof HttpError || err instanceof BridgeError ? err.message : "erro interno — veja os logs do Worker" }, status, cors);
    }
  },
  scheduled,
};
