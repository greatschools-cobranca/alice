# Colocando a Torre nova no ar — passo a passo

Ordem recomendada. Os passos 1–3 deixam o painel funcionando com auditoria e e-mail; o passo 4 liga a conversa e as tarefas.

## 1. Publicar o código

Juntar a branch `melhorias-torre` na `main` (pull request no GitHub). O GitHub Actions publica o Worker sozinho
e o GitHub Pages atualiza o painel em ~1 minuto.

## 2. Importar as rotinas (logo depois de publicar)

As definições das rotinas (destinatários, prompts, regras) saíram do código, que é público, e passam a ficar só no
banco da Torre. Até importar, o painel aparece sem rotinas e a Alice não encontra o estado delas.

1. Abra o painel → aba **Rotinas** → **Importar JSON**.
2. Escolha o arquivo `rotinas-seed.json` (fica na pasta *Torre de Comando*, **fora** do repositório — não suba esse arquivo para o GitHub).
3. Confira as 3 rotinas. O estado ligado/desligado que já existia é mantido.

Para mudar uma rotina depois: botão **Editar** no painel (fica registrado na auditoria).

## 3. E-mail de auditoria (Apps Script no Gmail da Alice)

1. Entre em https://script.google.com **com a conta Gmail da Alice** → *Novo projeto* → nome "Torre - e-mails".
2. Apague o conteúdo e cole o arquivo [`setup/apps-script/Code.gs`](apps-script/Code.gs).
3. Engrenagem (*Configurações do projeto*) → *Propriedades do script* → adicione:
   - `MAIL_SECRET` = uma senha longa e aleatória (ex.: gerada em https://passwordsgenerator.net, 40+ caracteres)
   - `ALLOWED_TO` = o e-mail que vai receber a auditoria (o seu e-mail corporativo)
4. No editor, selecione a função `testeManual` → **Executar** → autorize. Deve chegar um e-mail de teste.
5. **Implantar → Nova implantação** → tipo *App da Web* → *Executar como: Eu* → *Quem pode acessar: Qualquer pessoa* → Implantar.
   Copie a URL que termina em `/exec`.
6. No GitHub do repositório → *Settings → Secrets and variables → Actions → New repository secret*:
   - `MAIL_WEBHOOK_URL` = a URL `/exec`
   - `MAIL_WEBHOOK_SECRET` = o mesmo valor de `MAIL_SECRET`
   - `AUDIT_EMAIL_TO` = o e-mail que vai receber a auditoria (o seu e-mail corporativo)
7. *Actions → Deploy Torre de Controle Worker → Run workflow*.
8. No painel → aba **Auditoria** → **E-mail de teste**.

O que chega por e-mail:
- **Na hora:** rotina que falhou, rotina que não concluiu até o horário-limite, rotina que rodou estando desligada,
  tarefa que não chegou na Alice ou que falhou, tarefa parada há mais de 3h, login bloqueado por senha errada.
- **Todo dia após 18:30:** resumo com o estado de cada rotina, última execução, tarefas em aberto e a linha do tempo das últimas 24h.

Os horários-limite de cada rotina ficam no campo *Conferência de execução* (Editar rotina). No arquivo importado:
`agenda-cobranca` até 09:00 todos os dias; `emails-ina-ciclo-2027` até 17:30 às terças e quintas; `analise-base-cobranca` é sob demanda (sem conferência).

## 4. Ligação com a Alice (feita por quem opera a VPS)

Envie o [`setup/OPENCLAW.md`](OPENCLAW.md) para quem opera a Alice. São duas etapas do lado dela:

1. **Skill** — usa a `ALICE_API_KEY` (passe por canal privado). Libera a auditoria das execuções e as propostas de rotina.
2. **Ponte de saída, protocolo 2** ([`setup/ponte/README.md`](ponte/README.md)) — container separado na VPS, só com HTTPS de saída.
   Usa a chave própria `BRIDGE_API_KEY`, que precisa ser cadastrada como GitHub Secret (o operador gera o valor e entrega
   por canal protegido). A execução fica desligada (`ROUTINE_EXECUTION_ENABLED = "false"` no `worker/wrangler.toml`)
   até a homologação das agendas na VPS.

Nesta etapa a **conversa** e as **tarefas livres com anexos** ficam desligadas: o painel só pede a execução de rotinas cadastradas.

O topo do painel mostra: **Ponte** (aguardando conexão → conectada), **Gateway** (verificado ou não),
**Rotinas** (aguardando homologação → liberadas) e **E-mail**.

## Lista completa de GitHub Secrets

| Secret | Obrigatório | Observação |
|---|---|---|
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | sim | já existem |
| `JWT_SECRET` | sim | já existe; mínimo 16 caracteres |
| `USERS_JSON` | sim | já existe; senhas antigas continuam valendo e são reforçadas sozinhas no próximo login |
| `ALICE_API_KEY` | sim | chave que a Alice usa na skill (auditoria e propostas) |
| `BRIDGE_API_KEY` | para a ponte | chave exclusiva da ponte de saída; gerada pelo operador da VPS e entregue por canal protegido |
| `MAIL_WEBHOOK_URL`, `MAIL_WEBHOOK_SECRET`, `AUDIT_EMAIL_TO` | para e-mail | passo 3 |
| `OPENCLAW_*`, `CF_ACCESS_*` | **não** | sem uso desde o protocolo 2 (o token do gateway fica só na VPS) |
| `ROUTINE_WEBHOOK_URL` | opcional | webhook antigo de liga/desliga |

Para cadastrar usuário novo: `node worker/gen-hash.js "senha"` e adicione `{ "username": "...", "passwordHash": "<saída>" }` ao `USERS_JSON`.

## Sobre o histórico do Git

Os e-mails dos destinatários e as regras saíram do código, mas **continuam visíveis no histórico de commits antigos**
do repositório público. Para apagar de vez: tornar o repositório privado (GitHub Pages em repo privado exige plano pago)
ou reescrever o histórico (operação destrutiva — combinar antes).
