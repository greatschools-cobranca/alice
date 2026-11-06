/**
 * Torre de Controle — envio de e-mails de auditoria pelo Gmail da Alice.
 *
 * Como publicar (passo a passo completo em setup/CONFIGURAR.md):
 *  1. Logado na conta Gmail da Alice, abra https://script.google.com e crie um projeto.
 *  2. Cole este arquivo no lugar do Code.gs.
 *  3. Configurações do projeto (engrenagem) → Propriedades do script → adicione:
 *       MAIL_SECRET  = (mesmo valor do segredo MAIL_WEBHOOK_SECRET da Torre)
 *       ALLOWED_TO   = e-mails que podem receber (auditoria + cada pessoa com acesso à Torre), separados por vírgula
 *  4. Implantar → Nova implantação → Tipo "App da Web" →
 *       Executar como: "Eu" (a conta da Alice) · Quem pode acessar: "Qualquer pessoa".
 *  5. Autorize o acesso ao Gmail e copie a URL que termina em /exec → segredo MAIL_WEBHOOK_URL.
 *
 * Segurança: só envia com o segredo correto e só para os endereços de ALLOWED_TO.
 */
function doPost(e) {
  try {
    var props = PropertiesService.getScriptProperties();
    var secret = props.getProperty("MAIL_SECRET");
    var allowed = (props.getProperty("ALLOWED_TO") || "")
      .split(",")
      .map(function (s) { return s.trim().toLowerCase(); })
      .filter(String);

    var body = JSON.parse(e.postData.contents);
    if (!secret || body.secret !== secret) return reply_({ ok: false, error: "segredo inválido" });

    var to = String(body.to || "")
      .split(",")
      .map(function (s) { return s.trim(); })
      .filter(String);
    if (!to.length) return reply_({ ok: false, error: "destinatário vazio" });
    for (var i = 0; i < to.length; i++) {
      if (allowed.indexOf(to[i].toLowerCase()) === -1) {
        return reply_({ ok: false, error: "destinatário não autorizado: " + to[i] });
      }
    }

    MailApp.sendEmail({
      to: to.join(","),
      subject: String(body.subject || "Torre de Controle").slice(0, 250),
      htmlBody: String(body.html || ""),
      name: "Torre de Controle · Alice",
    });
    return reply_({ ok: true, remainingQuota: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return reply_({ ok: false, error: String(err) });
  }
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Rode manualmente no editor uma vez para autorizar o envio e conferir se chega. */
function testeManual() {
  var to = (PropertiesService.getScriptProperties().getProperty("ALLOWED_TO") || "").split(",")[0];
  MailApp.sendEmail(to, "[Torre] Teste do Apps Script", "Se chegou, o Apps Script está pronto.");
}
