# WSCore_Email

Serviço compartilhado de **envio de e-mail** do WSCore (SMTP — AWS SES). Guarda a configuração do servidor de envio num só lugar; os outros módulos só informam **destinatário(s), assunto e corpo** (texto/HTML) ou um **template com variáveis** e recebem de volta sucesso ou um erro claro. Conecta ao Core via Socket.IO, registra cada envio em `_Core_Email_Envios` e não tem tela.

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
| `limite_excedido` | rate limit | sim, mais tarde |
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

## Log de envios: `_Core_Email_Envios`

Uma linha por pedido que chegou a tentar o envio (pedidos recusados por validação, autorização ou rate limit vão só para o log de arquivo, sem endereços). Gravada **antes** de enviar (`enviando`) e atualizada depois (`enviado` / `falhou`); se não for possível gravar, o e-mail **não** é enviado.

Colunas: `id`, `criado_em`, `concluido_em`, `solicitante_modulo`, `usuario_id` (só com `ExigirPermissaoUsuario`), `referencia`, `para`, `cc`, `bcc`, `assunto`, `template`, `qtd_anexos`, `tamanho_bytes`, `transporte`, `status`, `message_id`, `erro_codigo`, `erro` (sem segredos; e-mails mascarados). O corpo e os anexos **não** são guardados. A tabela não é limpa automaticamente — apague registros antigos conforme a política de retenção (`DELETE FROM _Core_Email_Envios WHERE criado_em < ...`).

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
                             # Templates_Email, Transporte_Email (SMTP/simulado), Autorizacao_Email, Limitador_Taxa
    Lib/                     # Logger, Configuracao, Conector_Mysql, Erros, Autenticador_Cliente
    Modulos/Socket_Client.ts # handshake e cliente do Core
  Models/                    # Modelo_Configuracao, Modelo_Config_JSON.json, Email/Tipos, Modulos/*
  SQL/                       # schema_Core_Email.sql, data_Core_Email.sql
  Templates/                 # um diretório por template
tests/                       # node:test (npm test)
```
