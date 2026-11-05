# Ligar a Alice (OpenClaw) à Torre de Controle

Guia para quem mantém o OpenClaw onde a Alice roda. Duas etapas independentes — faça a 1 primeiro.

| Etapa | O que libera | Mexe em rede? | Reinicia o gateway? |
|---|---|---|---|
| **1. Skill `torre-de-controle`** | Alice respeita o liga/desliga, reporta execuções (auditoria e alertas), propõe rotinas | não | não |
| **2. Ponte de saída (protocolo 2)** | Botão "executar rotina cadastrada" do painel e liga/desliga aplicado sem IA nas agendas | não (só conexões de saída) | só se a recarga nativa não bastar — avisar antes |

Endereços: painel https://greatschools-cobranca.github.io/alice/ · API `https://torre-de-controle-api.alice-fontes.workers.dev`
Repositório: https://github.com/greatschools-cobranca/alice

Referências oficiais do OpenClaw: [OpenAI HTTP API](https://docs.openclaw.ai/gateway/openai-http-api) · [Webhooks](https://docs.openclaw.ai/automation/cron-jobs/webhooks) · [Skills](https://docs.openclaw.ai/tools/skills)

---

## Etapa 1 — Skill `torre-de-controle`

1. Copie a pasta da skill (do pacote `pacote-alice-torre.zip` ou do repositório) para o workspace da Alice:
   ```bash
   D=<workspace da Alice>/skills/torre-de-controle
   mkdir -p "$D/scripts"
   R=https://raw.githubusercontent.com/greatschools-cobranca/alice/main/setup/openclaw-skill/torre-de-controle
   curl -sL -o "$D/SKILL.md" "$R/SKILL.md"
   curl -sL -o "$D/scripts/torre.mjs" "$R/scripts/torre.mjs"
   ```
   (ou em `~/.openclaw/skills/torre-de-controle/` para valer para todos os agentes)

   A skill traz o auxiliar `scripts/torre.mjs` (Node 18+, sem dependências). Ele lê a chave do ambiente (ela não aparece
   nos argumentos dos processos), só baixa links de arquivo da própria Torre para uma pasta temporária controlada
   (nome saneado, 20 MB, tipos permitidos) e só envia arquivos de dentro do workspace (nunca ocultos ou com cara de credencial).
   Leia os dois arquivos antes de habilitar.
2. Em `~/.openclaw/openclaw.json`, aponte a chave para um **arquivo privado** (permissão 600), sem copiá-la
   para a configuração. A skill declara `primaryEnv: TORRE_AGENT_KEY`, então o campo `apiKey` vira essa variável:
   ```json5
   {
     secrets: {
       providers: {
         torre_agent_key: {
           source: "file",
           path: "/data/.config/torre-de-controle/ALICE_API_KEY.txt",   // arquivo privado, chmod 600
           mode: "singleValue",
         },
       },
     },
     skills: {
       entries: {
         "torre-de-controle": {
           enabled: true,
           apiKey: { source: "file", provider: "torre_agent_key", id: "value" },
           env: { TORRE_API_BASE: "https://torre-de-controle-api.alice-fontes.workers.dev" },
         },
       },
     },
   }
   ```
   Depois: `openclaw config validate`, `openclaw skills check` e testes só de leitura (`status` e `rotinas`).
   As variáveis valem para o processo do agente no host; se a Alice roda em sandbox, injete-as no sandbox.
   **Não cole a chave no chat com a Alice** — fica no histórico da conversa.
3. A Alice precisa conseguir rodar `node` (ferramenta de execução de comandos) com acesso à internet.
4. No prompt de cada rotina programada (cron do OpenClaw), acrescente no início:
   > Antes de começar, siga a skill torre-de-controle: confira se a rotina `<id>` está ligada e reporte `started`; ao final reporte `ok`, `error`, `wait` ou `skipped`.

   Ids atuais: `agenda-cobranca`, `analise-base-cobranca`, `emails-ina-ciclo-2027`.
5. Teste pedindo à Alice: *"Use a skill torre-de-controle e me diga quais rotinas estão ligadas."*
   Depois, para cada uma das três rotinas, um reporte de teste com `status` `skipped` e resumo "teste de integração" —
   devem aparecer na aba **Auditoria** do painel.

## Etapa 2 — Ponte de saída, protocolo 2 (execução de rotinas cadastradas)

Siga **[setup/ponte/README.md](ponte/README.md)** — procedimento do operador da VPS. Resumo:

- A ponte roda num container separado (`alice-torre-bridge`), só com HTTPS de saída para a Torre e a conexão interna
  já existente do gateway. **Não** liga `chatCompletions` nem hooks HTTP, não abre porta e não usa túnel, domínio ou VPN.
- Usa a chave própria `BRIDGE_API_KEY` (diferente da `ALICE_API_KEY` da skill). O token do gateway fica só na VPS.
- Só dispara rotinas cadastradas e mapeadas para jobs nativos do OpenClaw. Sem conversa livre, anexos ou instruções vindas do painel.
- O liga/desliga é aplicado sem IA por um gatilho nativo em cada agenda, que consulta `/api/routines/gate` antes de rodar.
- Começa em modo **observação** (não executa nada). A execução só é liberada depois da homologação das agendas na VPS
  (`mode=active` na ponte e `ROUTINE_EXECUTION_ENABLED=true` no Worker).

## Escopo desta etapa

- Conversa com a Alice pelo painel: **desligada**.
- Tarefas com texto livre ou anexos: **desligadas**. O painel só pede a execução de uma rotina cadastrada, na versão revisada.
- Próxima etapa prevista: rotinas que recebem arquivos de entrada declarados no cadastro (sem texto livre).
