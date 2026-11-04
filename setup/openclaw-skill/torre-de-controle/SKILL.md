---
name: torre-de-controle
description: Integração da Alice com a Torre de Controle (painel da equipe de Cobrança). Use SEMPRE antes e depois de executar qualquer rotina programada, ao receber uma tarefa vinda da Torre, para baixar arquivos enviados pela Torre e para propor rotinas novas.
metadata: {"openclaw":{"requires":{"env":["TORRE_API_BASE","TORRE_AGENT_KEY"],"bins":["curl"]}}}
---

# Torre de Controle

A Torre de Controle é o painel onde a equipe acompanha, liga/desliga e audita as rotinas da Alice.
Endereço da API: `$TORRE_API_BASE`. Toda chamada leva o cabeçalho `X-Agent-Key: $TORRE_AGENT_KEY`.

Nunca mostre a chave `TORRE_AGENT_KEY` em mensagens, arquivos ou logs.

## 1. Antes de rodar uma rotina programada

1. Consulte o estado: `curl -s "$TORRE_API_BASE/api/routines/status"` → `[{"id":"...","on":true}, ...]`.
2. Se a rotina estiver `"on": false`, **não execute**. Reporte `skipped` (passo 3) com o resumo "desligada na Torre".
3. As instruções oficiais de cada rotina (passo a passo, prompt, destinatários) ficam na Torre:
   `curl -s -H "X-Agent-Key: $TORRE_AGENT_KEY" "$TORRE_API_BASE/api/agent/routines"`.
   Se houver diferença entre o que você lembra e o que está na Torre, siga a Torre.

## 2. Reportar a execução (obrigatório — é a auditoria)

```bash
curl -s -X POST "$TORRE_API_BASE/api/agent/runs" \
  -H "X-Agent-Key: $TORRE_AGENT_KEY" -H "Content-Type: application/json" \
  -d '{"routineId":"emails-ina-ciclo-2027","status":"ok","summary":"4 regionais enviadas","details":"IDs dos e-mails de origem, destinatários, anexos..."}'
```

- `status`: `started` (começou), `ok` (concluiu), `error` (falhou), `skipped` (não precisou/estava desligada), `wait` (aguardando algo, ex.: imagens que ainda não chegaram).
- `summary`: uma linha, em português, com números quando houver (totais, quantidade de envios).
- `details` (opcional): o que for útil para auditoria — destinatários, Cc, assunto, totais, divergências. Não inclua dados pessoais de responsáveis financeiros (CPF, nomes de famílias).
- Reporte `started` ao começar e `ok`/`error` ao terminar. Se uma rotina tem horário-limite e você não reportar `ok`, `skipped` ou `error` até lá, a Renata recebe alerta de rotina atrasada.
- Atividade avulsa (pedida pelo Telegram, sem rotina cadastrada): use `"title":"<o que foi feito>"` no lugar de `routineId`.
- A resposta traz `routineOn`. Se vier `false` depois de você já ter rodado, avise no Telegram que a rotina estava desligada.

## 3. Tarefas vindas da Torre

Mensagens que começam com `[Torre de Controle] Nova tarefa` trazem um `ID da tarefa` (ex.: `t8206199326161-cc1ab1`).

1. Ao começar: `POST $TORRE_API_BASE/api/agent/tasks/<id>` com `{"status":"running"}`.
2. Arquivos anexados vêm como links temporários na própria mensagem. Baixe com:
   `curl -sL -o "<nome do arquivo>" "<link>"` (não precisa da chave; o link já é assinado e vale 72h).
   Para rever a tarefa e gerar links novos: `GET $TORRE_API_BASE/api/agent/tasks/<id>` com a chave.
3. Arquivos de resultado (planilhas geradas etc.): envie um por vez e guarde o `id` devolvido:
   ```bash
   curl -s -X POST "$TORRE_API_BASE/api/agent/files" \
     -H "X-Agent-Key: $TORRE_AGENT_KEY" \
     -H "Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" \
     -H "X-File-Name: Base_INA_processada.xlsx" \
     --data-binary @Base_INA_processada.xlsx
   ```
   Limite: 20 MB por arquivo.
4. Ao terminar: `POST .../api/agent/tasks/<id>` com
   `{"status":"done","result":"<resumo em markdown: premissas, totais, divergências>","files":["<id1>","<id2>"]}`.
5. Se não conseguir: `{"status":"error","result":"<o que deu errado e o que falta para concluir>"}`.

## 4. Conversa pela Torre

Mensagens que começam com `[Mensagem de <usuário> pela Torre de Controle]` vêm do chat do painel, não do Telegram.
Responda normalmente, em português. Se houver arquivos anexados, os links estão no fim da mensagem (baixe como no item 3.2).
Para trabalhos longos (mais de ~1 minuto), sugira que a pessoa abra uma **Tarefa** na Torre.

## 5. Propor rotinas novas ou mudanças

Você não altera rotinas sozinha. Proponha e a equipe aprova na Torre:

- Nova: `POST $TORRE_API_BASE/api/agent/routines` com
  `{"id":"revisar-boletos-atraso","name":"...","schedule":"dias úteis · 09:00 (America/Sao_Paulo)","description":"...","steps":[{"title":"...","items":["..."]}],"checks":[{"days":[1,2,3,4,5],"by":"10:00"}],"defaultOn":false}`
- Edição (só de rotinas que você criou): `POST $TORRE_API_BASE/api/agent/routines/<id>` com os campos que mudam.
- `checks.days`: 1 = segunda … 7 = domingo; `by`: horário-limite (HH:MM, horário de São Paulo).
