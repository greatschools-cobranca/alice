# Login com Google na Torre

Com isso configurado, a Torre só aceita quem entra com a conta Google da empresa
(**@greatschools.com.br**) **e** está na lista de e-mails autorizados. O login por senha é desligado.

## 1. Criar o "ID do cliente" no Google Cloud (uma vez)

Faça com uma conta @greatschools.com.br. Se o Google Workspace da empresa não permitir criar projetos,
peça ao administrador do Workspace.

1. Abra https://console.cloud.google.com/ e crie um projeto (ex.: **Torre de Controle**).
2. Menu **APIs e serviços → Tela de consentimento OAuth** (ou **Google Auth Platform**):
   - Tipo de usuário: **Interno** (só contas da organização conseguem usar).
   - Nome do app: **Torre de Controle da Alice**; e-mail de suporte: o seu.
   - Não é preciso adicionar escopos extras.
3. Menu **APIs e serviços → Credenciais → Criar credenciais → ID do cliente OAuth**:
   - Tipo de aplicativo: **Aplicativo da Web**; nome: **Torre**.
   - **Origens JavaScript autorizadas:** `https://greatschools-cobranca.github.io`
   - URIs de redirecionamento: deixe vazio.
   - Clique em **Criar** e copie o **ID do cliente** (termina em `.apps.googleusercontent.com`).
     Esse ID não é segredo; a "chave secreta do cliente" **não** é usada.

## 2. Cadastrar no GitHub (Settings → Secrets and variables → Actions)

| Secret | Valor |
|---|---|
| `GOOGLE_CLIENT_ID` | o ID do cliente copiado no passo 1 |
| `ALLOWED_EMAILS` | e-mails autorizados separados por vírgula, ex.: `fulana@greatschools.com.br,ciclano@greatschools.com.br` |

Depois: **Actions → Deploy Torre de Controle Worker → Run workflow**.

## 3. Testar

Abra o painel (Ctrl+F5). Deve aparecer só o botão **"Fazer login com o Google"**.
Entre com a sua conta; uma conta de fora da lista deve receber "este e-mail não está autorizado".

## Manutenção

- **Dar ou tirar acesso:** edite o secret `ALLOWED_EMAILS` e rode o workflow. Quem sai da lista perde a sessão na hora.
- **Tentativas negadas** aparecem na Auditoria ("Tentativa de acesso de … que não está na lista").
- **Emergência (Google fora do ar):** crie o secret `ALLOW_PASSWORD_LOGIN` = `true` e rode o workflow — o login por
  senha (`USERS_JSON`) volta a valer junto com o Google. Para desligar de novo, troque para `false` e rode o workflow.

## Como funciona (técnico)

O painel usa o Google Identity Services (botão em popup). A credencial recebida (ID token) é validada no Worker:
assinatura RS256 com as chaves públicas do Google, emissor, público (`GOOGLE_CLIENT_ID`), validade, e-mail verificado,
`hd = greatschools.com.br` e presença em `ALLOWED_EMAILS`. A sessão da Torre é emitida por 12 h e revalida a lista a
cada requisição. Arquivo: `worker/src/lib/google.js`.
