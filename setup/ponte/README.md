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

```bash
sudo mkdir -p /opt/ponte-torre && cd /opt/ponte-torre
sudo curl -sLO https://raw.githubusercontent.com/greatschools-cobranca/alice/main/setup/ponte/ponte-torre.mjs
sudo curl -sLO https://raw.githubusercontent.com/greatschools-cobranca/alice/main/setup/ponte/ponte.env.exemplo
sudo cp ponte.env.exemplo ponte.env && sudo chmod 600 ponte.env
sudo nano ponte.env          # preencha os valores (ver abaixo)
```

| Variável | Valor |
|---|---|
| `TORRE_API_BASE` | `https://torre-de-controle-api.alice-fontes.workers.dev` |
| `TORRE_AGENT_KEY` | a `ALICE_API_KEY` (a Renata passa por canal privado) |
| `OPENCLAW_URL` | `http://127.0.0.1:18789` (porta do gateway) |
| `OPENCLAW_GATEWAY_TOKEN` | `gateway.auth.token` (ou a senha, se o gateway usa modo password) |
| `OPENCLAW_HOOKS_TOKEN` | o `hooks.token` do passo 1 |
| `OPENCLAW_AGENT_ID` | `main` (ou o id do agente da Alice) |

Teste antes de ligar:

```bash
sudo node /opt/ponte-torre/ponte-torre.mjs --teste
```

Deve mostrar três `OK` e "Tudo certo".

## 3. Deixar rodando como serviço (systemd)

```bash
sudo curl -sL -o /etc/systemd/system/ponte-torre.service \
  https://raw.githubusercontent.com/greatschools-cobranca/alice/main/setup/ponte/ponte-torre.service
# se o node não estiver em /usr/bin/node, ajuste ExecStart (veja: which node)
# se o node estiver dentro de /home (ex.: instalado com nvm), troque ProtectHome=yes por ProtectHome=read-only
sudo systemctl daemon-reload
sudo systemctl enable --now ponte-torre
sudo journalctl -u ponte-torre -f       # acompanhar o log
```

No painel da Torre, o topo deve mostrar **Conversa: online (ponte)**.

O log registra só o id e o tipo de cada pedido — nunca o conteúdo das mensagens nem as chaves.

## Desligar / remover

```bash
sudo systemctl disable --now ponte-torre
sudo rm /etc/systemd/system/ponte-torre.service && sudo rm -r /opt/ponte-torre
```

Para desligar também os endpoints, volte `chatCompletions.enabled` e `hooks.enabled` para `false` e reinicie o gateway.

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| `A Torre recusou a chave` | `TORRE_AGENT_KEY` diferente da `ALICE_API_KEY` cadastrada no GitHub |
| `endpoint não encontrado` no teste | `chatCompletions.enabled` não foi ligado ou o gateway não foi reiniciado |
| `hooks desligados` | `hooks.enabled: true` faltando |
| `token do gateway recusado` | token/senha do gateway errado |
| Painel mostra "Ponte: sem sinal" | serviço parado (`systemctl status ponte-torre`) ou servidor sem internet |
| Conversa responde "sessão arquivada" | clicar em **Nova conversa** no painel |
