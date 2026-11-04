# Ligar a Alice (OpenClaw) à Torre de Controle

Guia para quem mantém o OpenClaw onde a Alice roda. Tempo estimado: 30–60 min.

A Torre de Controle (painel em GitHub Pages + API em Cloudflare Worker) precisa de três coisas do lado da Alice:

| O quê | Para quê | Onde no OpenClaw |
|---|---|---|
| Endpoint `POST /v1/chat/completions` | Conversar com a Alice pelo painel | `gateway.http.endpoints.chatCompletions` |
| Endpoint `POST /hooks/agent` | Mandar tarefas (com arquivos) para a Alice executar em segundo plano | `hooks` |
| Skill `torre-de-controle` | A Alice consultar liga/desliga, reportar execuções (auditoria) e devolver resultado das tarefas | `skills/` + `skills.entries` |

E um caminho HTTPS para o Worker da Cloudflare alcançar o gateway.

Referências oficiais: [OpenAI HTTP API](https://docs.openclaw.ai/gateway/openai-http-api) · [Webhooks](https://docs.openclaw.ai/automation/cron-jobs/webhooks) · [Skills](https://docs.openclaw.ai/tools/skills) · [Acesso remoto/Tailscale](https://docs.openclaw.ai/gateway/tailscale)

---

## 1. Habilitar os endpoints

Em `~/.openclaw/openclaw.json` (mesclar com o que já existe):

```json5
{
  gateway: {
    http: { endpoints: { chatCompletions: { enabled: true } } },
  },
  hooks: {
    enabled: true,
    token: "<TOKEN_LONGO_ALEATORIO_SO_PARA_HOOKS>",   // diferente do token do gateway
    path: "/hooks",
    allowedAgentIds: ["main"],                         // id do agente da Alice
    allowRequestSessionKey: false,
  },
}
```

Gere tokens com `openssl rand -hex 32`. Depois:

```bash
openclaw config validate
openclaw gateway restart
openclaw logs --follow
```

> O token do gateway (`gateway.auth.token`, ou a senha em `gateway.auth.password`) dá acesso de operador.
> Ele vai ficar guardado só como segredo no Worker da Cloudflare; não é exposto ao navegador.

Se o agente da Alice não for o `main`, anote o id — vira a variável `OPENCLAW_AGENT_ID` no `worker/wrangler.toml`.

## 2. Expor o gateway para o Worker (escolha uma opção)

O gateway escuta em `localhost:18789`. **Não abra essa porta direto na internet.**

### Opção A — Cloudflare Tunnel + Cloudflare Access (recomendada se a empresa tem um domínio na Cloudflare)

1. No host do OpenClaw: instale o `cloudflared` e rode
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create alice-gateway
   cloudflared tunnel route dns alice-gateway alice-gw.SEU-DOMINIO.com.br
   ```
2. `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: alice-gateway
   credentials-file: /caminho/para/<id-do-tunel>.json
   ingress:
     - hostname: alice-gw.SEU-DOMINIO.com.br
       service: http://localhost:18789
     - service: http_status:404
   ```
   e instale como serviço: `cloudflared service install`.
3. Painel Cloudflare → **Zero Trust → Access → Applications → Add (Self-hosted)** para `alice-gw.SEU-DOMINIO.com.br`,
   com uma política **Service Auth** que aceite um **Service Token** novo (Access → Service Auth → Create Service Token).
   Guarde o *Client ID* e o *Client Secret*.

O Worker manda os cabeçalhos `CF-Access-Client-Id`/`CF-Access-Client-Secret`, então só ele passa pelo Access.

### Opção B — Tailscale Funnel (sem domínio próprio)

```bash
openclaw gateway --tailscale funnel --auth password
```

O Funnel exige autenticação por senha no gateway (use uma senha longa e aleatória). A URL fica
`https://<maquina>.<tailnet>.ts.net`. Requisitos: Tailscale ≥ 1.38.3, MagicDNS, HTTPS e o atributo de funnel liberados no tailnet.
Nessa opção a senha do gateway é o `OPENCLAW_GATEWAY_TOKEN` (o OpenClaw aceita `Authorization: Bearer <senha>` em modo password).

### Teste

```bash
curl -s https://<URL-DO-GATEWAY>/v1/models -H "Authorization: Bearer <TOKEN_DO_GATEWAY>" \
  [-H "CF-Access-Client-Id: ..." -H "CF-Access-Client-Secret: ..."]
```

Deve responder com a lista de agentes.

## 3. Instalar a skill `torre-de-controle`

1. Copie a pasta `setup/openclaw-skill/torre-de-controle/` deste repositório para `<workspace da Alice>/skills/torre-de-controle/`
   (ou `~/.openclaw/skills/torre-de-controle/`).
2. Em `~/.openclaw/openclaw.json`:
   ```json5
   {
     skills: {
       entries: {
         "torre-de-controle": {
           enabled: true,
           env: {
             TORRE_API_BASE: "https://torre-de-controle-api.alice-fontes.workers.dev",
             TORRE_AGENT_KEY: "<ALICE_API_KEY — a Renata te passa>",
           },
         },
       },
     },
   }
   ```
   Observação: essas variáveis valem para o processo do agente no host; se a Alice roda em sandbox, injete-as no sandbox.
3. A Alice precisa conseguir rodar `curl` (ferramenta de execução de comandos) e ter acesso à internet.
4. Nas rotinas programadas (cron do OpenClaw), inclua no início do prompt de cada uma:
   > Antes de começar, siga a skill torre-de-controle: confira se a rotina `<id>` está ligada e reporte `started`; ao final reporte `ok`, `error`, `wait` ou `skipped`.

   Ids atuais: `agenda-cobranca`, `analise-base-cobranca`, `emails-ina-ciclo-2027`.

## 4. O que devolver para a Renata

Cadastrar como **GitHub Secrets** do repositório (Settings → Secrets and variables → Actions):

| Secret | Valor |
|---|---|
| `OPENCLAW_BASE_URL` | URL HTTPS do gateway (sem barra no fim) |
| `OPENCLAW_GATEWAY_TOKEN` | token (ou senha) do gateway |
| `OPENCLAW_HOOKS_TOKEN` | o `hooks.token` do passo 1 |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | só na opção A |

Depois de cadastrar, rode o workflow **Deploy Torre de Controle Worker** (Actions → Run workflow). No painel, o topo deve mostrar **Conversa: online**.

## Limitações conhecidas

- A conversa do painel usa uma sessão própria por pessoa (`torre-<usuário>-<n>`); a Alice não vê o histórico do Telegram ali, e vice-versa.
- Respostas muito demoradas (minutos sem enviar nada) podem ser cortadas pela rede; para isso existem as **Tarefas**.
- Se uma sessão for arquivada no Control UI, o painel mostra erro 409 — basta clicar em "Nova conversa".
