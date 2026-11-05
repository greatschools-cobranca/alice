# Ponte de saída Torre → Alice

Liga a **Conversa** e as **Tarefas** da Torre de Controle à Alice **sem expor o servidor**:
sem túnel, sem domínio, sem VPN, sem abrir porta. A ponte só faz conexões de saída
(HTTPS para a Torre; HTTP para o gateway em `127.0.0.1`).

```
Torre (internet) ◄── "tem algo pra mim?" a cada 3 s (HTTPS de saída) ── ponte-torre.mjs ──► gateway da Alice (localhost)
```

- Não consome tokens da OpenAI enquanto não há pedidos (as consultas à Torre não passam pelo modelo).
- Uso de CPU/memória desprezível. Requer Node.js 18+ (o OpenClaw já usa Node 22). Sem dependências.
- Se a ponte parar, a Torre mostra "Ponte: sem sinal" e manda alerta por e-mail após 10 minutos.

## 1. Ligar os endpoints do gateway (somente local)

Em `~/.openclaw/openclaw.json` (mesclar com o que já existe):

```json5
{
  gateway: {
    http: { endpoints: { chatCompletions: { enabled: true } } },
    // mantenha o bind padrão (loopback) — NÃO é preciso expor o gateway
  },
  hooks: {
    enabled: true,
    token: "<TOKEN_LONGO_ALEATORIO_SO_PARA_HOOKS>",   // gere com: openssl rand -hex 32
    path: "/hooks",
    allowedAgentIds: ["main"],                         // id do agente da Alice
    allowRequestSessionKey: false,
  },
}
```

```bash
openclaw config validate
openclaw gateway restart     # reinicia a Alice — combine um horário sem rotina rodando
```

## 2. Instalar a ponte

Use o mesmo usuário que roda o gateway (ou outro sem privilégios). Ajuste os caminhos se não houver `/opt` gravável.

```bash
mkdir -p /opt/ponte-torre && cd /opt/ponte-torre
curl -sLO https://raw.githubusercontent.com/greatschools-cobranca/alice/main/setup/ponte/ponte-torre.mjs
curl -sLO https://raw.githubusercontent.com/greatschools-cobranca/alice/main/setup/ponte/rodar-ponte.sh
curl -sLO https://raw.githubusercontent.com/greatschools-cobranca/alice/main/setup/ponte/ponte.env.exemplo
chmod +x rodar-ponte.sh
cp ponte.env.exemplo ponte.env && chmod 600 ponte.env
nano ponte.env          # preencha os valores (ver abaixo)
```

| Variável | Valor |
|---|---|
| `TORRE_API_BASE` | `https://torre-de-controle-api.alice-fontes.workers.dev` |
| `TORRE_AGENT_KEY` | a `ALICE_API_KEY` (a Renata passa por canal privado) |
| `OPENCLAW_URL` | `http://127.0.0.1:18789` (porta do gateway) |
| `OPENCLAW_GATEWAY_TOKEN` | `gateway.auth.token` (ou a senha, se o gateway usa modo password) |
| `OPENCLAW_HOOKS_TOKEN` | o `hooks.token` do passo 1 |
| `OPENCLAW_AGENT_ID` | `main` (ou o id do agente da Alice) |

Teste antes de ligar (use o caminho do node do servidor — `command -v node`):

```bash
/usr/local/bin/node /opt/ponte-torre/ponte-torre.mjs --teste
```

Deve mostrar três `OK` e "Tudo certo".

## 3. Deixar rodando

Use **o mesmo supervisor que mantém o gateway do OpenClaw** — assim a ponte sobe e reinicia junto com ele.
O script `rodar-ponte.sh` reinicia a ponte se ela cair (exceto em erro de configuração ou chave recusada, que exigem correção).

| Ambiente | Como |
|---|---|
| **supervisord** | bloco abaixo em `/etc/supervisor/conf.d/ponte-torre.conf` + `supervisorctl reread && supervisorctl update` |
| **pm2** | `pm2 start /opt/ponte-torre/rodar-ponte.sh --name ponte-torre --interpreter sh && pm2 save` |
| **Docker / docker compose** | serviço extra (sidecar) na mesma rede do gateway, com `command: sh /opt/ponte-torre/rodar-ponte.sh` e `restart: unless-stopped`; nesse caso `OPENCLAW_URL` aponta para o nome do serviço do gateway |
| **Script de entrada do container** | acrescente `nohup sh /opt/ponte-torre/rodar-ponte.sh >> /var/log/ponte-torre.log 2>&1 &` antes de iniciar o gateway |
| **systemd** (se estiver ativo) | `ponte-torre.service` deste diretório (ajuste `ExecStart` para o caminho do node) |

```ini
[program:ponte-torre]
command=/bin/sh /opt/ponte-torre/rodar-ponte.sh
environment=NODE_BIN="/usr/local/bin/node"
autostart=true
autorestart=unexpected
exitcodes=2,3
stdout_logfile=/var/log/ponte-torre.log
redirect_stderr=true
```

No painel da Torre, o topo deve mostrar **Conversa: online (ponte)**.

**O que o log registra:** id e tipo de cada pedido, tamanho da resposta e, em falhas, apenas o código HTTP.
Nunca registra o conteúdo das mensagens, corpos de resposta da Torre ou do gateway, nem chaves.

## 4. Confirmação (três testes)

Só considere a Torre conectada depois dos três:

1. `node ponte-torre.mjs --teste` → três `OK`.
2. Painel → aba **Conversa** → "Oi, Alice" → a resposta aparece.
3. Painel → aba **Tarefas** → tarefa simples (ex.: "Responda OK e conclua a tarefa") → status vai de "na fila" a "enviada" e depois "concluída" (este último depende da skill da Etapa 1).

## Nível de acesso (leia antes de ligar)

O endpoint de conversa usa o token geral do gateway, que a documentação do OpenClaw classifica como acesso de operador:
quem consegue pôr uma mensagem na fila consegue pedir à Alice qualquer coisa que as ferramentas dela permitam —
o mesmo poder de quem conversa com ela no Telegram.

Quem consegue pôr mensagem na fila:
- **Somente pessoas logadas no painel** (usuários do secret `USERS_JSON`, login com bloqueio após 5 erros).
- A chave da Alice (`TORRE_AGENT_KEY`) **não** cria pedidos: ela só retira pedidos já criados pelo painel e reporta resultados.
- A ponte só chama duas rotas do gateway (`/v1/chat/completions` e `/hooks/agent`), sempre para o agente configurado.

Portanto, os pontos a proteger são: a lista de usuários do painel, o `JWT_SECRET` e o acesso às contas GitHub/Cloudflare da Torre.
Se quiser reduzir o poder da conversa pela Torre, restrinja as ferramentas do agente no OpenClaw ou use um agente dedicado
(`OPENCLAW_AGENT_ID`) com permissões menores.

## Desligar / remover

Pare o processo pelo supervisor usado (ou `pkill -f rodar-ponte.sh; pkill -f ponte-torre.mjs`) e apague `/opt/ponte-torre`.
Para desligar também os endpoints, volte `chatCompletions.enabled` e `hooks.enabled` para `false` e reinicie o gateway.

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| `A Torre recusou a chave` | `TORRE_AGENT_KEY` diferente da `ALICE_API_KEY` cadastrada no GitHub |
| `endpoint não encontrado` no teste | `chatCompletions.enabled` não foi ligado ou o gateway não foi reiniciado |
| `hooks desligados` | `hooks.enabled: true` faltando |
| `token do gateway recusado` | token/senha do gateway errado |
| Painel mostra "Ponte: sem sinal" | processo parado (veja o supervisor/log) ou servidor sem internet |
| Conversa responde "sessão arquivada" | clicar em **Nova conversa** no painel |
