# Ligar a Alice (OpenClaw) à Torre de Controle

Guia para quem mantém o OpenClaw onde a Alice roda. Duas etapas independentes — faça a 1 primeiro.

| Etapa | O que libera | Mexe em rede? | Reinicia o gateway? |
|---|---|---|---|
| **1. Skill `torre-de-controle`** | Alice respeita o liga/desliga, reporta execuções (auditoria e alertas), propõe rotinas | não | não |
| **2. Ponte de saída** | Aba **Conversa** e aba **Tarefas** do painel | não (só conexões de saída) | sim, uma vez |

Endereços: painel https://greatschools-cobranca.github.io/alice/ · API `https://torre-de-controle-api.alice-fontes.workers.dev`
Repositório: https://github.com/greatschools-cobranca/alice

Referências oficiais do OpenClaw: [OpenAI HTTP API](https://docs.openclaw.ai/gateway/openai-http-api) · [Webhooks](https://docs.openclaw.ai/automation/cron-jobs/webhooks) · [Skills](https://docs.openclaw.ai/tools/skills)

---

## Etapa 1 — Skill `torre-de-controle`

1. Baixe a skill para o workspace da Alice:
   ```bash
   mkdir -p <workspace da Alice>/skills/torre-de-controle
   curl -sL -o <workspace da Alice>/skills/torre-de-controle/SKILL.md \
     https://raw.githubusercontent.com/greatschools-cobranca/alice/main/setup/openclaw-skill/torre-de-controle/SKILL.md
   ```
   (ou em `~/.openclaw/skills/torre-de-controle/` para valer para todos os agentes)
2. Em `~/.openclaw/openclaw.json`, injete as variáveis da skill:
   ```json5
   {
     skills: {
       entries: {
         "torre-de-controle": {
           enabled: true,
           env: {
             TORRE_API_BASE: "https://torre-de-controle-api.alice-fontes.workers.dev",
             TORRE_AGENT_KEY: "<ALICE_API_KEY — a Renata passa por canal privado>",
           },
         },
       },
     },
   }
   ```
   As variáveis valem para o processo do agente no host; se a Alice roda em sandbox, injete-as no sandbox.
   **Não cole a chave no chat com a Alice** — fica no histórico da conversa.
3. A Alice precisa conseguir rodar `curl` (ferramenta de execução de comandos) com acesso à internet.
4. No prompt de cada rotina programada (cron do OpenClaw), acrescente no início:
   > Antes de começar, siga a skill torre-de-controle: confira se a rotina `<id>` está ligada e reporte `started`; ao final reporte `ok`, `error`, `wait` ou `skipped`.

   Ids atuais: `agenda-cobranca`, `analise-base-cobranca`, `emails-ina-ciclo-2027`.
5. Teste pedindo à Alice: *"Use a skill torre-de-controle e me diga quais rotinas estão ligadas."*

## Etapa 2 — Ponte de saída (Conversa e Tarefas)

Siga **[setup/ponte/README.md](ponte/README.md)**. Resumo:

1. Ligar `gateway.http.endpoints.chatCompletions` e `hooks` no `openclaw.json` (gateway continua só em `localhost`) e reiniciar o gateway uma vez.
2. Copiar `ponte-torre.mjs` e `rodar-ponte.sh` para `/opt/ponte-torre`, preencher `ponte.env` e rodar `--teste`
   com o node do servidor (ex.: `/usr/local/bin/node`).
3. Deixar rodando pelo **mesmo supervisor que mantém o gateway** (supervisord, pm2, entrypoint do container ou systemd, se ativo).
4. Fazer os três testes de confirmação e ler a seção **Nível de acesso** do guia da ponte.

A ponte só faz conexões de saída e não consome tokens enquanto não há pedidos.
Nenhum segredo novo precisa ser cadastrado no GitHub para esse modo.

---

## Alternativa — modo direto (túnel)

Só se, no futuro, preferirem que a Torre acesse o gateway diretamente (resposta da conversa letra por letra, sem os 2–3 s da ponte).
Exige expor o gateway por **Cloudflare Tunnel + Cloudflare Access** (precisa de domínio na Cloudflare) ou **Tailscale Funnel**
(`openclaw gateway --tailscale funnel --auth password`). Depois cadastre no GitHub os secrets `OPENCLAW_BASE_URL`,
`OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_HOOKS_TOKEN` e, com Cloudflare Access, `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`.

> Atenção: **cadastrar `OPENCLAW_BASE_URL` troca a Torre para o modo direto** e a ponte deixa de ser usada.
> Sem esse secret, a Torre fica no modo ponte.

## Limitações conhecidas

- A conversa do painel usa uma sessão própria por pessoa (`torre-<usuário>-<n>`); a Alice não vê o histórico do Telegram ali, e vice-versa.
- Mensagens que a ponte não retirar em 90 s aparecem como erro no painel ("a ponte da Alice não respondeu"); tarefas esperam até 30 min.
- Se uma sessão for arquivada no Control UI, o painel mostra erro — basta clicar em "Nova conversa".
