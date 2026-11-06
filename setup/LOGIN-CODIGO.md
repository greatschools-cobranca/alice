# Login por código no e-mail (sem Google Cloud)

Quem acessa a Torre digita o e-mail **@greatschools.com.br**. Se o e-mail estiver na lista autorizada, recebe um
**código de 6 dígitos** (vale 10 minutos, uso único) e entra com ele. Com isso ligado, o login por senha é desligado.

O código é enviado pelo mesmo **Apps Script** que manda os alertas da auditoria (veja `setup/CONFIGURAR.md`, passo 3).

## Configurar

1. **Apps Script** (se ainda não estiver configurado, siga o passo 3 do `CONFIGURAR.md`).
   Nas *Propriedades do script*, a propriedade `ALLOWED_TO` precisa conter **todos** os e-mails que recebem algo da Torre:
   o e-mail da auditoria e cada pessoa autorizada, separados por vírgula. Exemplo:
   `renata@greatschools.com.br,fulana@greatschools.com.br,ciclano@greatschools.com.br`
2. **GitHub Secrets** (Settings → Secrets and variables → Actions):

   | Secret | Valor |
   |---|---|
   | `ALLOWED_EMAILS` | e-mails autorizados, separados por vírgula |
   | `MAIL_WEBHOOK_URL` | URL `/exec` do Apps Script |
   | `MAIL_WEBHOOK_SECRET` | o mesmo valor de `MAIL_SECRET` no Apps Script |

3. **Actions → Deploy Torre de Controle Worker → Run workflow.**
4. Abra o painel (Ctrl+F5): deve aparecer **"E-mail da empresa"** e **"Enviar código"**.

## Regras de segurança

- Só e-mails do domínio `greatschools.com.br` **e** presentes em `ALLOWED_EMAILS`.
- A resposta ao pedir o código é sempre a mesma — não revela quem está na lista. Pedidos de e-mails fora da lista
  ficam registrados na Auditoria.
- Código de 6 dígitos, válido por 10 minutos, de uso único; 5 tentativas erradas invalidam o código;
  no máximo 3 códigos por e-mail a cada 15 minutos.
- O código nunca é gravado em texto (só um resumo criptográfico) e nunca aparece na auditoria.
- A sessão vale 12 horas e revalida a lista a cada uso: quem sai de `ALLOWED_EMAILS` perde o acesso na hora.

## Manutenção

- **Dar ou tirar acesso:** edite `ALLOWED_EMAILS` (e `ALLOWED_TO` no Apps Script) e rode o workflow.
- **Emergência** (e-mail fora do ar): secret `ALLOW_PASSWORD_LOGIN` = `true` + workflow reabre o login por senha (`USERS_JSON`).
- O botão "Entrar com Google" continua disponível no código: basta cadastrar `GOOGLE_CLIENT_ID` (veja `LOGIN-GOOGLE.md`).
  Com os dois configurados, a tela mostra as duas opções.
