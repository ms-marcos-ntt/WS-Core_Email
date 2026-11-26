# WSCore_Email

Serviço compartilhado de **envio de e-mail** do WSCore (SMTP — AWS SES). Guarda a configuração do servidor de envio num só lugar; os outros módulos só informam **destinatário(s), assunto e corpo** (texto/HTML) ou um **template com variáveis** e recebem de volta sucesso ou um erro claro. Conecta ao Core via Socket.IO, registra cada envio em `_Core_Email_Envios` e tem uma **tela** de histórico, uso e controle de limites (veja [Tela](#tela-histórico-uso-e-limites)).

O primeiro cliente é o `WS-Mod_FibraMap` (e-mail de aprovação de Pré-Viabilidade).

## Requisitos

- Node.js na versão do [`.nvmrc`](.nvmrc);
- MySQL/MariaDB acessível, com permissão de criar tabelas no database configurado (o mesmo database do Core/Autenticador);
- WS-Core rodando; WS-Core_Autenticador no mesmo banco (só necessário se `Autorizacao.ExigirPermissaoUsuario` for ligado);
- Credenciais SMTP (AWS SES) — ver [Configuração](#configuração). Sem elas o módulo sobe, mas recusa os envios com erro claro.

## Comandos

```bash
npm ci               # instala as dependências (não mexe no banco)
npm run dev          # desenvolvimento (ts-node-dev --transpile-only, sem checagem de tipos)
npm run typecheck    # checagem de tipos
npm run build        # compila para dist/ (limpa o build anterior antes)
npm start            # produção: executa dist/Server/WSCore_Email.js (rode o build antes)
npm run setup        # cria/atualiza tabela e permissão sem subir o módulo
npm test             # testes (não precisam de banco, de Core nem de SMTP)
```

Como `npm run dev` não checa tipos, rode `npm run typecheck` antes de commitar.

Deploy: `npm ci` → `npm run build` → `npm start`.

Não é preciso rodar `npm run setup` no dia a dia: a cada inicialização o módulo cria a tabela que falta e aplica a permissão `email.enviar` (idempotente).

Release (padrão dos demais módulos, via `standard-version`): `npm run release`, `release:first`, `release:dry-run`, `release:patch|minor|major`.

## Configuração

`Server/config/config.cfg` (JSON, **fora do git**). Na primeira execução o módulo cria o arquivo com os padrões e pede para você preenchê-lo. Campos ausentes são completados com os padrões; caminhos relativos partem da raiz do módulo.

```jsonc
{
  "BD":   { "Usuario": "root", "Senha": "", "Database": "wscore", "Host": "127.0.0.1", "Porta": 3306 },
  "Core": { "Host": "127.0.0.1", "Porta": 7000, "Segredo": "", "TimeoutMs": 35000 },
  "WebFiles": { "Pasta_Arquivos_Html": "./Views/_web" },   // telas servidas ao WebServer (evento webfiles)
  "SMTP": {
    "Modo": "smtp",            // "smtp" envia de verdade; "simulado" não envia nada (desenvolvimento)
    "Host": "",                // AWS SES: email-smtp.<região>.amazonaws.com
    "Porta": 587,              // 587 + Seguro=false (STARTTLS)  ou  465 + Seguro=true (TLS direto)
    "Seguro": false,
    "Usuario": "",             // usuário SMTP do SES (não é a chave de acesso IAM comum)
    "Senha": "",
    "Remetente": "",           // "TurboOne <nao-responda@seudominio.com.br>" — domínio/endereço verificado no SES
    "TimeoutMs": 20000
  },
  "Email": {
    "PastaTemplates": "./Server/Templates",
    "Limites": { "MaxDestinatarios": 50, "MaxAssunto": 200, "MaxTexto": 100000, "MaxHtml": 200000,
                 "MaxAnexos": 3, "MaxAnexoBytes": 1048576, "MaxTotalAnexosBytes": 2097152 }
  },
  "Autorizacao": {
    "ModulosPermitidos": ["WSMod_FibraMap"],   // Modulo_Nome de quem pode pedir envio; vazio = ninguém
    "ExigirPermissaoUsuario": false,
    "PermissaoEnvio": "email.enviar"
  },
  "RateLimit": { "JanelaSegundos": 60, "MaximoPorModulo": 30, "MaximoGlobal": 120 },
  "LOG": { "Console": true, "Arquivo": true, "LocalArquivo": "./log/wscore_email/", "Rotatividade": 86400 },
  "modulo": { "nome": "WSCore_Email", "versao": "0.1.0" }
}
```

- `Core.Segredo` deve ser igual ao `Core.SegredoModulos` do WS-Core quando ele estiver configurado.
- **Nunca** coloque credenciais reais em arquivo versionado: `config.cfg` está no `.gitignore`. Em desenvolvimento use `"SMTP": { "Modo": "simulado" }` — o envio é só registrado (log + tabela), nada sai da máquina.
- `SMTP.Modo = "smtp"` com Host/Usuario/Senha/Remetente vazios: o módulo avisa no log ao subir e **todo** pedido de envio recebe `codigo: "nao_configurado"` dizendo exatamente qual campo preencher.
- AWS SES: a conta nova começa em *sandbox* (só envia para endereços verificados) e o remetente/domínio precisa estar verificado. Erros `554`/`550` do servidor chegam como `smtp_erro` com essa dica.

## Segurança e autorização

O WebServer repassa ao Core qualquer evento/destino emitido pelo navegador de um usuário logado. Sem controle, qualquer usuário poderia chamar `email/enviar` e usar o remetente da empresa. Por isso:

1. Cada pacote traz `origem` (o `Modulo_ID` que o Core deu a quem enviou). O módulo resolve o ID para o nome (`core/modulos/listar`) e só aceita nomes de `Autorizacao.ModulosPermitidos`. O WebServer **não** está na lista, então pedidos de navegador são recusados (`nao_autorizado`). Para liberar um novo módulo, adicione o nome dele em `ModulosPermitidos` e reinicie.
2. Opcional — `ExigirPermissaoUsuario: true`: além do módulo, o pacote precisa trazer o `token` de um usuário com a permissão `email.enviar` (criada pelo `setup` na tabela `_Permissoes` do Autenticador). Por padrão fica desligado: os módulos permitidos são infraestrutura confiável (passaram pelo `Core.SegredoModulos`) e cada um confere a permissão do usuário no próprio domínio (ex.: `fibramap.*`) antes de pedir o e-mail.
3. Limite conhecido: o Core não sobrescreve `origem`; um módulo registrado poderia informar o ID de outro. Todo módulo registrado já é de confiança (segredo compartilhado).

Outras proteções: validação rígida (campos desconhecidos recusados; e-mails ASCII válidos, sem `Nome <x@y>`; sem quebra de linha em assunto/endereços — evita injeção de cabeçalho); limites de quantidade/tamanho; anexos pequenos, sem extensões executáveis, nome sem caminho; variáveis de template escapadas em HTML; o remetente vem **só** do config (quem pede não escolhe o `From`); STARTTLS obrigatório fora do modo 465 e TLS ≥ 1.2; nodemailer sem leitura de arquivo/URL; rate limit por módulo e global (janela deslizante); mensagens de erro sem endereços, texto do servidor SMTP nem credenciais (segredos e e-mails são mascarados no log e na tabela).

## Evento `email/enviar`

Destino: `WSCore_Email/*`. O corpo (`dados`, JSON) aceita:

| Campo | Tipo | Observação |
|---|---|---|
| `para` | `string \| string[]` | **obrigatório** (≥ 1) |
| `cc`, `bcc` | `string \| string[]` | opcionais; total `para+cc+bcc` ≤ `MaxDestinatarios`; duplicados são removidos |
| `assunto` | `string` | obrigatório sem `template`; sem quebra de linha |
| `texto` / `html` | `string` | sem `template`, informe um dos dois (ou ambos). Só HTML → a parte texto é gerada |
| `template` + `variaveis` | `string` + `{ nome: string\|number\|boolean }` | alternativa a `assunto`/`texto`/`html` (não misture) |
| `anexos` | `[{ nome, conteudoBase64, tipo? }]` | até 3, 1 MB cada, 2 MB no total |
| `responderPara` | `string` | e-mail para o "Responder" |
| `referencia` | `string` (≤ 120) | texto livre para rastrear (ex.: `fibramap:pre_viabilidade:123`) — fica no log |

Resposta de sucesso:

```json
{ "status": "OK", "dados": { "id": 15, "messageId": "<...@email.amazonses.com>", "destinatarios": 2, "aceitos": 2, "recusados": 0, "transporte": "smtp" } }
```

Resposta de erro (`mensagem` é segura para exibir; `codigo` serve para decidir o que fazer):

```json
{ "status": "Erro", "mensagem": "E-mail inválido em \"para\" (posição 1)", "codigo": "validacao" }
```

| `codigo` | Quando | Reenviar? |
|---|---|---|
| `validacao` | pacote inválido, variável de template faltando | não — corrija o pedido |
| `template_invalido` | template inexistente/incompleto | não |
| `nao_autorizado` | módulo fora de `ModulosPermitidos` / sem permissão | não |
| `limite_excedido` | rate limit do config.cfg (`RateLimit`) | sim, mais tarde (segundos) |
| `limite_diario` | o pedido faria o consumo de hoje passar do **limite diário** definido na tela (ver [Limites e pausa](#limites-diário-e-mensal-e-pausa)); nada foi enviado nem registrado | sim, a partir da meia-noite (Brasília) ou se o limite for aumentado |
| `limite_mensal` | idem para o **limite mensal** | sim, a partir do dia 1º do mês seguinte ou se o limite for aumentado |
| `pausado` | chave **"pausar envios"** ligada na tela; nada foi enviado nem registrado | sim, depois que um administrador desligar a pausa (não adianta repetir em loop) |
| `nao_configurado` | SMTP sem credenciais | não — falta configurar o módulo |
| `smtp_autenticacao` | usuário/senha SMTP recusados | não — corrigir config |
| `smtp_conexao`, `smtp_timeout` | rede/servidor SMTP | sim, mais tarde |
| `smtp_destinatario` | servidor recusou remetente/destinatários (ex.: sandbox do SES) | não |
| `smtp_erro` | outras recusas do servidor | depende (ver `mensagem`) |
| `interno` | falha ao registrar no banco etc. (**nada foi enviado**) | sim, mais tarde |

Outros eventos: `email/templates` (lista os templates; módulos permitidos) e `email/ping` (público: `{ modulo, versao, transporte, configurado }`).

### Templates

Uma pasta por template em `Server/Templates/<nome>/` (nome: minúsculas, números, `_`, `-`):

- `assunto.txt` — assunto (1ª linha);
- `corpo.html` e/ou `corpo.txt` — corpo. Se só houver HTML, a parte texto é gerada.

Variáveis: `{{nome}}`. No HTML o valor é **escapado**; em texto/assunto entra como veio. Variável usada e não informada → `validacao` listando as que faltam; variáveis extras são ignoradas. Os arquivos são lidos a cada envio (editar um template não exige reiniciar). Templates incluídos: `generico` (`titulo`, `mensagem`) e `pre_viabilidade_aprovacao` (`codigo`, `nome_destinatario`, `solicitante`, `cliente`, `endereco`, `link_aprovacao`) — este último é um ponto de partida: ajuste texto e variáveis ao que o FibraMap realmente tiver. Passe em `link_aprovacao` apenas URLs `https://` geradas pelo próprio sistema.

### Exemplo: o FibraMap chamando `email/enviar` através do Core

Formato do pacote que chega ao Core (o `Socket_Client.emit` do FibraMap já monta isso; `dados` é uma **string JSON**):

```json
{
  "evento": "email/enviar",
  "destino": "WSCore_Email/*",
  "origem": "<Modulo_ID do FibraMap atribuído pelo Core>",
  "token": "",
  "dados": "{\"para\":[\"aprovador@netturbo.com.br\"],\"template\":\"pre_viabilidade_aprovacao\",\"variaveis\":{\"codigo\":\"PV-123\",\"nome_destinatario\":\"Ana\",\"solicitante\":\"Bruno\",\"cliente\":\"ACME\",\"endereco\":\"Rua A, 100\",\"link_aprovacao\":\"https://turbo.exemplo.com.br/fibramap/aprovar/123\"},\"referencia\":\"fibramap:pre_viabilidade:123\"}"
}
```

Uso a partir do código do FibraMap (usa o `Socket_Client` que ele já tem; o `nome` do módulo no `config.cfg` do FibraMap — `modulo.nome` = `WSMod_FibraMap` — precisa estar em `Autorizacao.ModulosPermitidos` deste módulo):

```ts
interface Resposta_Email { status: "OK" | "Erro"; mensagem?: string; codigo?: string; dados?: { id: number; messageId: string } }

function Enviar_Email(core: Socket_Client, token: string, dados: object): Promise<Resposta_Email> {
  return new Promise((resolve) => core.emit("email/enviar", "WSCore_Email/*", token, dados, resolve));
}

const r = await Enviar_Email(core, pacote.token, {
  para: [aprovador.email],
  template: "pre_viabilidade_aprovacao",
  variaveis: { codigo, nome_destinatario: aprovador.nome, solicitante: usuario.nome, cliente, endereco, link_aprovacao: link },
  referencia: `fibramap:pre_viabilidade:${preViabilidadeId}`,
});
if (r.status !== "OK") {
  // não derrube o fluxo de aprovação por causa do e-mail: registre e siga (codigo "limite_excedido"/"smtp_conexao"/"smtp_timeout"/"interno" podem ser reenviados depois)
  logger.Warning("[FibraMap] E-mail de aprovação não enviado:", r.codigo, r.mensagem);
}
```

Observações para a integração: `emit` com callback sempre responde (o Core indisponível ou o módulo de e-mail fora do ar volta como `{ status: "Erro" }`); o tempo máximo de uma chamada é o `Core.TimeoutMs` do FibraMap (35 s) e o do SMTP é `SMTP.TimeoutMs` (20 s); o campo `token` só é lido se `ExigirPermissaoUsuario` estiver ligado.

## Tela: histórico, uso e limites

Menu **E-mail** (ícone `mail`) com duas telas, criadas pelo `setup`/inicialização em `_Menus` (veja `Server/SQL/data_Core_Email_Tela.sql`) e servidas pelo próprio módulo via evento `webfiles` (arquivos em `Views/_web/{js,css}`; só `.html .js .css .json .svg .txt .map`, com bloqueio de traversal):

- **Histórico de envios** (`email/historico`, `Controle_Tela_Tabela`): tabela sobre `_Core_Email_Envios` — data/hora, módulo solicitante, referência, destinatários, assunto, template, status (enviado/falhou/enviando), código do erro, tamanho/anexos. Pesquisa por texto, filtros de status, módulo e período, paginação e ordenação **no servidor** (as colunas ordenáveis são uma lista fixa; texto vindo da tela nunca entra no SQL — vai por parâmetro). Selecione uma linha e use **Detalhes** para ver o envio por inteiro (destinatários completos, `Message-ID`, detalhe do erro). O corpo da mensagem e os anexos não são guardados.
- **Uso e limites** (`email/uso`, tela livre): enviados na última hora, hoje e no mês contra os limites (barra de % e cor por faixa: verde normal, âmbar a partir do % de alerta, vermelho esgotado), taxa de falha, série de 7 ou 30 dias, quebra por módulo e por status, últimos erros, os limites do `config.cfg` em **somente leitura**, o histórico de alterações de limite e o formulário de **controle** (só para quem tem `email.administrar`).

> **Atenção — destinatários:** `para`, `cc` e `bcc` são gravados como foram enviados (endereços completos; só o texto do campo `erro` mascara e-mails). A tela mostra o que está no banco, por isso o acesso é controlado por permissão. Se isso não for desejado, mascare na consulta de `Historico_Email.ts`.

### Permissões

Criadas por `npm run setup` (e a cada subida) na `_Permissoes` do Autenticador; atribua-as a um perfil:

| Permissão | Permite |
|---|---|
| `email.visualizar` | ver o menu, o histórico, o uso e os limites (somente leitura) |
| `email.administrar` | além disso, alterar limites/alerta e pausar/retomar os envios (exige também `email.visualizar` para abrir a tela) |
| `email.enviar` | só usada se `Autorizacao.ExigirPermissaoUsuario` estiver ligado (pedido de envio com token de usuário) |

Os eventos da tela (`email/historico/listar`, `email/historico/obter`, `email/historico/opcoes`, `email/uso/resumo`, `email/controle/salvar`) são chamados pelo **navegador** (via WebServer). Por isso, ao contrário de `email/enviar` (que só aceita módulos de `ModulosPermitidos`), **cada um valida o token do usuário e a permissão no Autenticador** (`usuarios/logintoken` + `usuarios/autorizar`, igual ao FibraMap) antes de tocar no banco — fail-closed: token ausente/inválido, Autenticador fora do ar ou permissão negada recusam com `codigo: "nao_autorizado"`. O Autenticador_Cliente guarda o resultado por até 30 s, então revogar um acesso vale em até 30 s. O botão de salvar some para quem só visualiza, mas quem vale é a checagem do servidor em `email/controle/salvar`.

### Limites (diário e mensal) e pausa

Guardados no banco (`_Core_Email_Configuracao`: `limite_diario`, `limite_mensal`, `percentual_alerta`, `pausado`, com quem alterou e quando) e editados na tela. **Padrão: limites 0 (= sem limite), alerta em 80%, sem pausa.** Valem para o **módulo todo** (não por módulo solicitante). Os limites do `config.cfg` (`RateLimit`, `Email.Limites`, `ModulosPermitidos`) continuam valendo à parte e aparecem na tela só para leitura.

Validação do formulário (cliente e servidor): somente inteiros; diário 0 a 1.000.000, mensal 0 a 10.000.000, alerta 1 a 100, pausa verdadeiro/falso; campo desconhecido é recusado; diário maior que o mensal (quando ambos > 0) é recusado.

**Como o envio respeita isso** (`email/enviar`, nesta ordem, antes de enviar ou registrar qualquer coisa): rate limit do config.cfg → **pausa** (`pausado`) → **diário** (`consumo de hoje + destinatários do pedido > limite` → `limite_diario`) → **mensal** (`limite_mensal`). O pedido que ultrapassaria o limite é bloqueado **inteiro** (não envia parte dos destinatários). Se o banco falhar ao ler o controle, o e-mail não é enviado (`interno`). A conferência e a reserva do saldo são feitas em fila no processo, então pedidos simultâneos não passam juntos pelo mesmo saldo (uma instância do módulo por banco).

**Regra de consumo — a unidade é o destinatário aceito** (como a cota do AWS SES, que conta por destinatário):

| Situação | Consome cota? |
|---|---|
| `enviado` | sim, os destinatários que o servidor SMTP **aceitou** (`qtd_aceitos`; recusa parcial não conta) |
| `falhou` | não |
| `enviando` | sim, como **reserva** (`qtd_destinatarios`), mas só por 10 minutos — registro "enviando" mais velho é de um processo que caiu e deixa de contar |
| pedido recusado antes do SMTP (validação, autorização, rate limit, limite, pausa) | não — nem entra na tabela (fica só no log de arquivo, sem endereços) |

**"Hoje" e "mês" são no fuso America/Sao_Paulo** (UTC-3): o módulo grava `criado_em`/`concluido_em` nesse horário e calcula todos os períodos nele (virada à meia-noite de Brasília, dia 1º do mês), independente do fuso do servidor ou do banco. Registros gravados pela versão 0.1.0 (sem fuso definido) podem ficar deslocados se o banco não estava em Brasília — afeta só o histórico antigo.

O aviso de alerta aparece no topo da tela de uso quando o consumo passa do % de alerta (âmbar), quando esgota (vermelho) e quando há pausa. **Toda alteração** de limite/alerta/pausa grava um registro em `_Core_Email_Configuracao_Historico` (chave, valor antes/depois, usuário, horário) **antes** de mudar o valor — se a auditoria falhar, nada muda — e uma linha no log (`[Email] Controle alterado pelo usuário #id: limite_diario 0 -> 500`). Só números e a chave de pausa: nenhum segredo.

Bancos criados na 0.1.0 ganham as colunas `qtd_destinatarios`/`qtd_aceitos` (preenchidas a partir de `para`+`cc`+`bcc` e do status) na primeira subida desta versão.

## Log de envios: `_Core_Email_Envios`

Uma linha por pedido que chegou a tentar o envio (pedidos recusados por validação, autorização ou rate limit vão só para o log de arquivo, sem endereços). Gravada **antes** de enviar (`enviando`) e atualizada depois (`enviado` / `falhou`); se não for possível gravar, o e-mail **não** é enviado.

Colunas: `id`, `criado_em`, `concluido_em`, `solicitante_modulo`, `usuario_id` (só com `ExigirPermissaoUsuario`), `referencia`, `para`, `cc`, `bcc`, `assunto`, `template`, `qtd_anexos`, `tamanho_bytes`, `qtd_destinatarios`, `qtd_aceitos`, `transporte`, `status`, `message_id`, `erro_codigo`, `erro` (sem segredos; e-mails mascarados). O corpo e os anexos **não** são guardados. As datas ficam em horário de São Paulo. A tabela não é limpa automaticamente — apague registros antigos conforme a política de retenção (`DELETE FROM _Core_Email_Envios WHERE criado_em < ...`).

```sql
SELECT id, criado_em, solicitante_modulo, referencia, status, erro_codigo FROM _Core_Email_Envios ORDER BY id DESC LIMIT 50;
```

## Estrutura

```
Server/
  WSCore_Email.ts            # entrada (config → banco → Core → handlers)
  Install.ts                 # npm run setup
  Controllers/
    Email/                   # Socket_Email (eventos), Config_Email (serviço), Validacao_Email,
                             # Templates_Email, Transporte_Email (SMTP/simulado), Autorizacao_Email, Limitador_Taxa,
                             # Controle_Email (limites/pausa), Uso_Email (consumo/painel), Historico_Email (consultas),
                             # Relogio_Email (fuso de SP), Socket_Email_Tela (eventos da tela, por permissão)
    Lib/                     # Logger, Configuracao, Conector_Mysql, Erros, Autenticador_Cliente
    Modulos/                 # Socket_Client (handshake com o Core), Socket_WebFiles (telas)
  Models/                    # Modelo_Configuracao, Modelo_Config_JSON.json, Email/Tipos, Modulos/*
  SQL/                       # schema_Core_Email*.sql, data_Core_Email.sql (permissão de envio), data_Core_Email_Tela.sql (menu + permissões da tela)
  Templates/                 # um diretório por template
Views/_web/{js,css}/         # telas (Email.js, Email.css), servidas via webfiles
tests/                       # node:test (npm test)
```
