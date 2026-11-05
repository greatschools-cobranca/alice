# Torre de Controle da Alice

Painel da equipe de Cobrança para acompanhar, conversar e acionar a Alice (agente de IA no OpenClaw/Telegram).

- **Conversa** com a Alice direto no painel, com anexos.
- **Tarefas**: pedir uma atividade avulsa (com arquivos); a Alice trabalha em segundo plano e devolve resultado e arquivos.
- **Rotinas**: ligar/desligar, editar, pedir execução na hora, ver a última execução.
- **Auditoria**: linha do tempo de tudo; alerta por e-mail na hora em caso de falha ou atraso e resumo diário às 18:30.
- **Pendências**: rotinas novas ou alterações que a Alice propõe só valem depois de aprovadas.

Painel: https://greatschools-cobranca.github.io/alice/

## Como está organizado

```
docs/index.html                    painel (GitHub Pages)
worker/src/index.js                API (Cloudflare Worker) — rotas
worker/src/cron.js                 conferência a cada 30 min: atrasos, tarefas paradas, resumo diário
worker/src/lib/                    autenticação, auditoria, e-mail, arquivos, OpenClaw, armazenamento
worker/wrangler.toml               configuração do Worker (KV, cron, variáveis)
worker/gen-hash.js                 gera hash de senha para o USERS_JSON
setup/CONFIGURAR.md                passo a passo para colocar no ar
setup/OPENCLAW.md                  guia para quem mantém a Alice (endpoints, túnel, skill)
setup/openclaw-skill/              skill que ensina a Alice a falar com a Torre
setup/ponte/                       ponte de saída: liga Conversa/Tarefas sem expor o servidor da Alice
setup/apps-script/Code.gs          envio de e-mail pelo Gmail da Alice
```

Toda alteração em `worker/` na branch `main` é publicada automaticamente pelo GitHub Actions; os segredos ficam em GitHub Secrets.

## Dados e segurança

- As definições das rotinas (destinatários, prompts, regras) **não ficam no código** — ficam no armazenamento KV da Torre e são editadas pelo painel.
- O login usa token assinado (sem cookie de terceiros, funciona no iPhone), senhas com PBKDF2 e bloqueio após 5 tentativas.
- A API só aceita chamadas do navegador vindas do endereço do painel (`ALLOWED_ORIGINS`).
- Arquivos anexados ficam 7 dias; o download é por link assinado com validade.
- A Alice se autentica com `X-Agent-Key` e não consegue alterar rotinas sem aprovação.

Rotas da API e lista de segredos: comentário no topo de [`worker/src/index.js`](worker/src/index.js) e [`setup/CONFIGURAR.md`](setup/CONFIGURAR.md).
