# Ponte de saída — protocolo 2

Estado deste pacote: código testado com fixtures; preparado na VPS da Alice em modo de observação e PARADO. Não representa ativação em produção. A publicação da Torre e a homologação dos gatilhos nativos ainda são necessárias.

## O que muda

- HTTPS somente de saída para a origem fixa da Torre. Não instala Tailscale, túnel, VPN, domínio ou portas públicas.
- Gateway por WebSocket interno já existente, protocolo 4, na mesma namespace Docker da Alice. Não habilita chatCompletions nem hooks HTTP.
- Só solicita rotinas previamente cadastradas e mapeadas para jobs nativos. Sem conversa livre, anexos ou comandos recebidos do painel.
- Chave `BRIDGE_API_KEY` exclusiva. A chave e o token do Gateway ficam em arquivos privados na VPS; o token do Gateway nunca vai para a Torre ou para o navegador.
- Definições e liga/desliga passam a ter autoridade no Durable Object. A primeira leitura importa o estado atual, inclusive os desligamentos, sem modificar as agendas da Alice.
- Solicitação com requestId estável e concessão identificada. Diário SQLite WAL/FULL e outbox persistem antes do envio; confirmação perdida é reenviada, comando incerto não é repetido.
- Apenas uma solicitação manual ativa. Não despacha enquanto há uma rotina nativa marcada em execução. Isso não serializa, por si só, todos os trabalhos nativos que o agendador iniciar depois.
- Aceitação técnica, término do cron e resultado de negócio são conceitos distintos. `done` da ponte prova término do job nativo, não a qualidade do arquivo, o envio de e-mail ou o resultado financeiro.
- Retenção de recibos de 7 dias, até 500 recibos e 100 pendências. Operações incertas preservam o recibo e bloqueiam novas execuções até reconciliação. Nunca apagar o diário para destravar a fila.

## Publicação por quem administra a Torre

1. Revisar e aplicar o patch a partir do commit `50db68ade624ae49914cca3ea6d044b1d7f6e55c`. Não usar conta ou token pessoal do Diego. A publicação deve ser feita pelo responsável pelo repositório/Cloudflare da Torre.
2. Rodar `node --test tests/*.test.mjs` com Node 24 e os testes Python de `tests/gate_test.py`.
3. Cadastrar `BRIDGE_API_KEY` como segredo do Worker ou do repositório da Torre, por campo protegido. O valor foi gerado na VPS em `/opt/alice-torre-bridge/secrets/bridge-key`. Não publicar esse arquivo, colar no chat nem incluí-lo no patch. Combine uma forma protegida de cadastrá-lo; a chave `ALICE_API_KEY` existente continua separada.
4. Publicar Worker e painel com `ROUTINE_EXECUTION_ENABLED = "false"`. O workflow inclui a nova variável de segredo. O modo v1 foi desativado e não consome os pedidos antigos.
5. Conferir `/api/routines/gate`: protocolo 2, apenas IDs/estados/revisões, sem nomes, instruções ou segredos. Resposta não pode ser HTML nem redirect. Conferir estado atual das três rotinas no painel; não recriar/importar um seed sobre os dados existentes.
6. Operador da VPS pode iniciar a ponte em observação e conferir heartbeat separado da saúde do Gateway. Observação não chama `/next` nem executa rotinas.

## Homologação das agendas — antes de liberar execução

A versão instalada da Alice possui cron nativo com `trigger.script`. O modelo fornecido em `trigger.example.js` é um candidato a validar na própria versão; NÃO foi aplicado às agendas existentes. `guardVerified=false` impede ativação automática.

1. Avisar antes de qualquer reinício do Gateway e aguardar janela sem rotina em execução. Preferir recarga nativa, quando suportada, sem reiniciar o container Hostinger.
2. Fazer cópia privada consistente da configuração e apenas das declarações/estados das agendas afetadas, conferindo o limite de backups. Não copiar OAuth para a Torre.
3. Validar, sem IA e com fixtures, que o executor headless chama o exec permitido, aguarda o resultado e bloqueia em HTML, timeout, ausência de dados, revisão diferente e estado desligado. O gatilho não recebe a chave da ponte: consulta `/api/routines/gate`, sem cache nem redirects.
4. Instalar `gate.py` e o JSON de mapeamentos, sem segredos, em `/data/.config/torre-de-controle/`. Pinar ID e SHA-256 em cada script. Habilitar `cron.triggers.enabled` só após conferir o schema da versão e o comportamento de recarga.
5. Aplicar SOMENTE `trigger` nos jobs mapeados. Não mudar payload, modelo, destinatário, horário, delivery ou enabled. Preservar as janelas atualmente desabilitadas. Não habilitar o antigo cron de sincronização baseado em IA.
6. Recalcular o fingerprint nativo após inserir o trigger; marcar `guardVerified=true` apenas após comprovação. Qualquer mudança externa posterior bloqueia o pedido até revisão.
7. Revisar o mapeamento de oito agendas técnicas para três rotinas de negócio. Os três jobs restantes são preservados; não presumir que toda agenda pertence à Torre. O job manual escolhido deve estar habilitado e ser confirmado com o responsável da rotina.
8. Só depois alterar a configuração da ponte para `mode=active` e o Worker para `ROUTINE_EXECUTION_ENABLED=true`. Reiniciar apenas a ponte para reler seu arquivo. Não disparar rotina real, e-mail ou chamada de IA como teste sem autorização específica.

O desligamento é verificado na admissão de cada execução. Não interrompe trabalho já admitido ou em execução. Se a Torre ficar indisponível, o gatilho bloqueia novas execuções mapeadas; essa dependência precisa ser aceita pelos responsáveis antes da ativação.

## Docker e recursos

O container `alice-torre-bridge` usa a imagem já existente da Alice por ID exato, usuário 1000:1000, filesystem somente leitura, capabilities removidas, no-new-privileges, sem Docker socket, sem portas, memória máxima de 128 MiB e 0,10 CPU. Só o próprio estado é gravável. `flock` evita dois processos sobre o mesmo diário; a trava do kernel é liberada após queda.

A medição de conexão/leitura consumiu aproximadamente 58 MiB de RSS, não uma medição de operação prolongada. O intervalo de consulta varia de 10 a 30 segundos, com recuo até 60 segundos em falhas; heartbeat é amortizado. A consulta não usa IA. Cotas e plano Cloudflare precisam ser conferidos pelo dono da conta; não se promete custo zero fora das cotas contratadas.

Se a Alice for recriada, a namespace Docker muda: conferir o novo container e religar apenas a ponte. O container preparado está com restart=no; não habilitar restart automático antes dessa revisão.

## Falha e retorno

- Parar somente `alice-torre-bridge`; a Alice continua funcionando.
- Preservar diário, concessões, outbox e recibos incertos. Conferir o runId no cron nativo, sem executar novamente para testar.
- Remover/restaurar apenas os triggers e o campo global alterados, respeitando mudanças externas posteriores; não restaurar um banco antigo com tokens OAuth.
- Reverter o Worker exige cuidado: depois da migração, o estado autoritativo está no Durable Object, e o KV antigo pode estar defasado. Antes de voltar à versão v1, exportar o estado atual por canal privado e migrá-lo conscientemente; não reativar a fila antiga.
- Nenhuma restauração deve apagar evidências de uma execução cujo resultado ainda não foi determinado.
