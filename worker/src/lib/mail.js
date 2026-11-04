// Envio de e-mail via Google Apps Script publicado na conta Gmail da Alice.
// Veja setup/apps-script/Code.gs e setup/CONFIGURAR.md.
import { escapeHtml, fmtSp } from "./util.js";

export function mailConfigured(env) {
  return !!(env.MAIL_WEBHOOK_URL && env.MAIL_WEBHOOK_SECRET && env.AUDIT_EMAIL_TO);
}

export async function sendMail(env, subject, html) {
  if (!mailConfigured(env)) return { ok: false, error: "e-mail não configurado" };
  try {
    const res = await fetch(env.MAIL_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: env.MAIL_WEBHOOK_SECRET, to: env.AUDIT_EMAIL_TO, subject, html }),
      redirect: "follow",
    });
    const text = await res.text();
    let body = {};
    try {
      body = JSON.parse(text);
    } catch {
      /* Apps Script às vezes devolve HTML em caso de erro */
    }
    if (!res.ok || body.ok !== true) {
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

const SEV_COLOR = { error: "#B23A3A", warn: "#B5732A", info: "#0F7A73" };
const SEV_LABEL = { error: "FALHA", warn: "ATENÇÃO", info: "info" };

function wrap(title, inner, panelUrl) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#211E16;max-width:720px">
<h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(title)}</h2>
${inner}
<p style="font-size:12px;color:#78715D;margin-top:24px">Torre de Controle da Alice${
    panelUrl ? ` · <a href="${escapeHtml(panelUrl)}">abrir painel</a>` : ""
  }</p></div>`;
}

export function alertEmail(env, event) {
  const color = SEV_COLOR[event.severity] || SEV_COLOR.info;
  const rows = [
    ["Quando", fmtSp(event.at)],
    ["Tipo", event.type],
    ["Rotina", event.routineName || event.routineId],
    ["Tarefa", event.taskId],
    ["Por", event.actor],
  ]
    .filter(([, v]) => v)
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#78715D">${k}</td><td style="padding:4px 0">${escapeHtml(v)}</td></tr>`
    )
    .join("");
  const inner = `<p style="border-left:4px solid ${color};padding:8px 12px;background:#FBF8F1;margin:0 0 12px">${escapeHtml(
    event.summary
  )}</p><table style="font-size:14px;border-collapse:collapse">${rows}</table>${
    event.details ? `<pre style="white-space:pre-wrap;background:#F6F3EC;padding:12px;font-size:12px">${escapeHtml(event.details)}</pre>` : ""
  }`;
  return {
    subject: `[Torre · ${SEV_LABEL[event.severity] || "aviso"}] ${event.summary}`.slice(0, 180),
    html: wrap("Alerta da Torre de Controle", inner, env.PANEL_URL),
  };
}

export function digestEmail(env, dateLabel, events, routines, lastRuns, openTasks) {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const e of events) counts[e.severity] = (counts[e.severity] || 0) + 1;

  const routineRows = routines
    .map((r) => {
      const lr = lastRuns[r.id];
      return `<tr>
<td style="padding:6px 10px;border-bottom:1px solid #E4DDCB">${escapeHtml(r.name)}</td>
<td style="padding:6px 10px;border-bottom:1px solid #E4DDCB">${r.on ? "ligada" : "desligada"}</td>
<td style="padding:6px 10px;border-bottom:1px solid #E4DDCB">${lr ? escapeHtml(`${lr.status} · ${fmtSp(lr.at)}`) : "sem registro"}</td>
<td style="padding:6px 10px;border-bottom:1px solid #E4DDCB">${lr ? escapeHtml(lr.summary || "") : ""}</td></tr>`;
    })
    .join("");

  const eventRows = events.length
    ? events
        .map(
          (e) => `<tr>
<td style="padding:4px 10px;border-bottom:1px solid #E4DDCB;white-space:nowrap;font-size:12px;color:#78715D">${escapeHtml(fmtSp(e.at))}</td>
<td style="padding:4px 10px;border-bottom:1px solid #E4DDCB;font-size:12px;color:${SEV_COLOR[e.severity] || "#211E16"}">${escapeHtml(
            SEV_LABEL[e.severity] || e.severity
          )}</td>
<td style="padding:4px 10px;border-bottom:1px solid #E4DDCB;font-size:13px">${escapeHtml(e.summary)}</td>
<td style="padding:4px 10px;border-bottom:1px solid #E4DDCB;font-size:12px;color:#78715D">${escapeHtml(e.actor || "")}</td></tr>`
        )
        .join("")
    : `<tr><td style="padding:8px;color:#78715D">Nenhum evento nas últimas 24h.</td></tr>`;

  const taskRows = openTasks.length
    ? `<h3 style="font-size:15px;margin:20px 0 8px">Tarefas em aberto</h3><ul>${openTasks
        .map((t) => `<li>${escapeHtml(t.title)} — ${escapeHtml(t.status)} (desde ${escapeHtml(fmtSp(t.createdAt))})</li>`)
        .join("")}</ul>`
    : "";

  const inner = `<p style="margin:0 0 16px">Últimas 24h: <b style="color:${SEV_COLOR.error}">${counts.error} falha(s)</b>, <b style="color:${
    SEV_COLOR.warn
  }">${counts.warn} atenção</b>, ${counts.info} evento(s) informativos.</p>
<h3 style="font-size:15px;margin:0 0 8px">Rotinas</h3>
<table style="font-size:13px;border-collapse:collapse;width:100%">
<tr style="text-align:left;color:#78715D"><th style="padding:6px 10px">Rotina</th><th style="padding:6px 10px">Estado</th><th style="padding:6px 10px">Última execução</th><th style="padding:6px 10px">Resumo</th></tr>
${routineRows}</table>
${taskRows}
<h3 style="font-size:15px;margin:20px 0 8px">Linha do tempo</h3>
<table style="border-collapse:collapse;width:100%">${eventRows}</table>`;

  return {
    subject: `[Torre] Resumo diário ${dateLabel} — ${counts.error} falha(s), ${events.length} evento(s)`,
    html: wrap(`Resumo diário · ${dateLabel}`, inner, env.PANEL_URL),
  };
}
