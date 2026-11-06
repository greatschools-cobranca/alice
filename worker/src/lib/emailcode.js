// Login por código enviado ao e-mail da empresa (sem Google Cloud).
// Requer: ALLOWED_EMAILS (lista) + MAIL_WEBHOOK_URL/MAIL_WEBHOOK_SECRET (Apps Script que envia o e-mail).
import { HttpError, escapeHtml } from "./util.js";
import { hmac } from "./auth.js";
import { fila } from "./fila.js";
import { sendMailTo } from "./mail.js";
import { allowedDomain, emailAuthorized, allowedEmails } from "./google.js";

export const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_REQUESTS = 3; // por e-mail a cada 15 min
const REQUEST_WINDOW_MS = 15 * 60 * 1000;

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

async function codeHash(env, email, code) {
  return hmac(env.JWT_SECRET, `otp:${email}:${code}`);
}

function newCode() {
  // 6 dígitos sem viés: rejeita valores acima do maior múltiplo de 1.000.000
  const buf = new Uint32Array(1);
  let n;
  do { crypto.getRandomValues(buf); n = buf[0]; } while (n >= 4294000000);
  return String(n % 1000000).padStart(6, "0");
}

/**
 * Pede um código. Sempre devolve a mesma resposta (não revela quem está na lista);
 * o retorno interno diz o que aconteceu, para a auditoria.
 */
export async function requestCode(env, emailRaw) {
  const email = normalizeEmail(emailRaw);
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, "digite um e-mail válido");
  if (!email.endsWith("@" + allowedDomain(env))) throw new HttpError(400, `use o seu e-mail @${allowedDomain(env)}`);
  if (!emailAuthorized(env, email)) return { outcome: "denied", email };

  const count = await fila(env).otpCountRequest(email, REQUEST_WINDOW_MS);
  if (count > MAX_REQUESTS) throw new HttpError(429, "muitos códigos pedidos; aguarde 15 minutos");

  const code = newCode();
  await fila(env).otpSet(email, { hash: await codeHash(env, email, code), exp: Date.now() + CODE_TTL_MS, attempts: 0 });
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#2E2829;max-width:520px">
<p style="font-size:15px">Seu código de acesso à <b>Torre de Controle da Alice</b>:</p>
<p style="font-size:32px;letter-spacing:8px;font-weight:bold;color:#13574D;margin:16px 0">${escapeHtml(code)}</p>
<p style="font-size:13px;color:#6A6164">Vale por 10 minutos e só pode ser usado uma vez.<br>
Se não foi você que pediu, ignore este e-mail — ninguém entra sem o código.</p></div>`;
  const res = await sendMailTo(env, email, `Seu código de acesso à Torre: ${code}`, html);
  if (!res.ok) {
    await fila(env).otpDelete(email);
    throw new HttpError(502, "não consegui enviar o e-mail com o código agora; tente de novo em alguns minutos");
  }
  return { outcome: "sent", email };
}

/** Confere o código. Devolve o e-mail ou lança 401/429. */
export async function verifyCode(env, emailRaw, codeRaw) {
  const email = normalizeEmail(emailRaw);
  const code = String(codeRaw || "").replace(/\D/g, "");
  if (!emailAuthorized(env, email) || code.length !== 6) throw new HttpError(401, "código inválido ou vencido");
  const rec = await fila(env).otpGet(email);
  if (!rec) throw new HttpError(401, "código inválido ou vencido; peça um novo");
  if (rec.attempts >= MAX_ATTEMPTS) {
    await fila(env).otpDelete(email);
    throw new HttpError(429, "muitas tentativas erradas; peça um novo código");
  }
  if ((await codeHash(env, email, code)) !== rec.hash) {
    rec.attempts += 1;
    if (rec.attempts >= MAX_ATTEMPTS) await fila(env).otpDelete(email);
    else await fila(env).otpSet(email, rec);
    throw new HttpError(401, rec.attempts >= MAX_ATTEMPTS ? "muitas tentativas erradas; peça um novo código" : "código incorreto");
  }
  await fila(env).otpDelete(email); // uso único
  return email;
}

export { allowedEmails };
