# Torre de Controle

Painel com login para acompanhar e ligar/desligar as rotinas da Alice, publicado no GitHub (frontend) + Cloudflare Workers (backend/API).

## Como está organizado

```
frontend/index.html   -> a página (GitHub Pages serve isso)
worker/src/index.js   -> a API (login, sessão, rotinas, toggle) — Cloudflare Worker
worker/wrangler.toml  -> config do Worker
worker/gen-hash.js    -> gera o hash de senha pra cadastrar um usuário
```

## Por que dois lugares?

O GitHub Pages só serve arquivos estáticos (HTML/CSS/JS) — ele não roda código no
servidor. Como o painel precisa de login de verdade e vai (no futuro) mandar um
comando pra Alice, essa parte roda num Worker da Cloudflare, que tem plano
gratuito generoso e é rápido de publicar.

## Passo 1 — Publicar o frontend no GitHub Pages

1. Crie um repositório novo no GitHub (pode ser privado).
2. Suba o conteúdo da pasta `frontend/` pra raiz do repositório (ou pra uma pasta `docs/`).
3. Em **Settings → Pages**, escolha a branch e a pasta onde está o `index.html` e salve.
4. O GitHub te dá uma URL tipo `https://seu-usuario.github.io/torre-de-controle/`.

> Repositório privado + GitHub Pages exige GitHub Pro/Team/Enterprise pra a página
> ficar acessível. Se o repositório for público, a página HTML fica pública — mas
> como ela não mostra nada sem logar (o login é validado no Worker, não no
> navegador), isso é seguro mesmo com o repo público.

## Passo 2 — Publicar o backend (Cloudflare Worker)

1. Crie uma conta gratuita em https://dash.cloudflare.com (se ainda não tiver).
2. Instale a CLI: `npm install -g wrangler`
3. Dentro da pasta `worker/`, rode `wrangler login` (abre o navegador pra autorizar).
4. Crie o armazenamento de estado:
   ```
   wrangler kv namespace create ROTINAS
   ```
   Copie o `id` que aparece e cole em `wrangler.toml` no lugar de `COLE_AQUI_O_ID_DO_KV`.
5. Gere o hash da(s) senha(s) do time:
   ```
   node gen-hash.js "senha-da-renata"
   node gen-hash.js "senha-da-outra-pessoa"
   ```
   Cada linha imprime algo como `a1b2c3d4$e5f6...` — isso é o `passwordHash`.
6. Configure os segredos do Worker:
   ```
   wrangler secret put JWT_SECRET
   ```
   (cole qualquer string longa e aleatória quando pedir)
   ```
   wrangler secret put USERS_JSON
   ```
   (cole algo assim, com os hashes gerados no passo 5:)
   ```json
   [
     { "username": "renata", "passwordHash": "a1b2c3d4$e5f6..." },
     { "username": "nomedapessoa", "passwordHash": "..." }
   ]
   ```
7. Publique: `wrangler deploy`
8. O Wrangler mostra a URL da API, algo como `https://torre-de-controle-api.SEU-SUBDOMINIO.workers.dev`.

## Passo 3 — Ligar o frontend na API

No `frontend/index.html`, antes do `</head>` ou logo no início do `<script>`, defina:

```html
<script>window.TORRE_API_BASE = "https://torre-de-controle-api.SEU-SUBDOMINIO.workers.dev";</script>
```

com a URL que o Wrangler te deu. Suba essa mudança pro GitHub e a página já fala com o backend.

## Sobre o "ligar/desligar de verdade"

Hoje o interruptor já é real no sentido de que liga/desliga fica salvo no
backend e visível pra todo o time (não é só visual como na primeira versão).
O que ainda falta é a ponte final até a Alice: como ela só entende comando
digitado no chat do Telegram, falta decidir como automatizar esse envio. As
duas formas possíveis:

- **Webhook no OpenClaw (recomendado):** se quem mantém a automação da Alice
  conseguir adicionar um gatilho HTTP (além do gatilho do Telegram) que pausa
  ou retoma uma rotina, o Worker já está pronto pra chamar essa URL — é só
  configurar o segredo `ROUTINE_WEBHOOK_URL` (`wrangler secret put
  ROUTINE_WEBHOOK_URL`) apontando pra ela.
- **Simular uma mensagem no Telegram:** possível, mas exige logar com uma
  conta de usuário do Telegram (não só o token do bot) rodando em algo que
  fique sempre ligado — é mais delicado de manter com segurança e não está
  incluído nesta primeira versão.

Enquanto a ponte não existe, cada clique fica registrado em "Últimas ações"
com a marca "só registrado aqui", pra ficar claro que ainda não chegou na Alice.

## Adicionando ou mudando rotinas

A lista de rotinas está no início de `worker/src/index.js`, na constante
`DEFAULT_ROUTINES`. Edite nome, horário e descrição ali, faça `wrangler
deploy` de novo e o painel já reflete a mudança.
