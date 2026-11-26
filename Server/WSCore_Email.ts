import { Conector_Mysql } from "./Controllers/Lib/Conector_Mysql";
import { Logger } from "./Controllers/Lib/Logger";
import { Cadastro_Dados_Banco } from "./Controllers/Cadastro_Dados_Banco";
import { Modelo_Configuracao } from "./Models/Modelo_Configuracao";
import { Socket_Client } from "./Controllers/Modulos/Socket_Client";
import { Modulos_Struct } from "./Models/Modulos/Modulos_Struct";
import { Autenticador_Cliente } from "./Controllers/Lib/Autenticador_Cliente";
import { Carregar_Configuracao, Erro_Configuracao, NaRaiz } from "./Controllers/Lib/Configuracao";
import { Descrever_Erro } from "./Controllers/Lib/Erros";
import { Autorizacao_Email, Resolvedor_Modulos_Core } from "./Controllers/Email/Autorizacao_Email";
import { Config_Email } from "./Controllers/Email/Config_Email";
import { Limitador_Taxa } from "./Controllers/Email/Limitador_Taxa";
import { Socket_Email } from "./Controllers/Email/Socket_Email";
import { Templates_Email } from "./Controllers/Email/Templates_Email";
import { Criar_Transporte, Transporte_Email } from "./Controllers/Email/Transporte_Email";

const logger = new Logger();
let bd: Conector_Mysql | undefined;
let core: Socket_Client | undefined;
let transporte: Transporte_Email | undefined;
let segredos: Array<string | undefined> = [];
let encerrando = false;


/** Desliga o processo de forma ordenada. */
async function Encerrar(codigo: number): Promise<void> {
  if (encerrando) return;
  encerrando = true;
  setTimeout(() => process.exit(codigo), 5000).unref();
  try {
    core?.Desconectar();
    transporte?.Fechar();
    await bd?.Fechar();
    await Logger.FecharArquivo();
  } catch (erro) {
    logger.Error("Ao encerrar o WS-Core_Email:", Descrever_Erro(erro, segredos));
  }
  process.exit(codigo);
}

process.on("uncaughtException", (erro) => { logger.Error("[Email] Exceção não tratada, encerrando:", Descrever_Erro(erro, segredos)); void Encerrar(1); });
process.on("unhandledRejection", (motivo) => { logger.Error("[Email] Promise rejeitada sem tratamento:", Descrever_Erro(motivo, segredos)); });
process.on("SIGINT", () => { logger.System("[Email] SIGINT recebido, encerrando."); void Encerrar(0); });
process.on("SIGTERM", () => { logger.System("[Email] SIGTERM recebido, encerrando."); void Encerrar(0); });


/** Testa o banco e cria as tabelas/permissões que faltam. */
async function PrepararBanco(config: Modelo_Configuracao): Promise<Conector_Mysql> {
  const conector = new Conector_Mysql({ user: config.BD.Usuario, password: config.BD.Senha, database: config.BD.Database, host: config.BD.Host, port: config.BD.Porta });
  await conector.Testar();
  logger.System("Conectado ao banco de dados:", `${config.BD.Host}:${config.BD.Porta}`);
  const instalacao = new Cadastro_Dados_Banco(conector);
  await instalacao.Inicializar_Tabelas();
  await instalacao.Inicializar_Permissoes();
  return conector;
}


async function iniciar(): Promise<void> {
  let config: Modelo_Configuracao;
  try {
    config = Carregar_Configuracao();
  } catch (erro) {
    logger.Error(erro instanceof Erro_Configuracao ? erro.message : erro);
    await Encerrar(1);
    return;
  }
  Logger.Configurar(config.LOG, "wscore_email");
  segredos = [config.SMTP.Senha, config.SMTP.Usuario, config.Core.Segredo, config.BD.Senha];

  try {
    transporte = Criar_Transporte(config.SMTP);
  } catch (erro) {
    logger.Error(erro instanceof Error ? erro.message : erro);
    await Encerrar(1);
    return;
  }
  // Sem credenciais o módulo sobe mesmo assim (os outros módulos continuam funcionando) e
  // cada pedido de envio recebe um erro claro dizendo o que falta preencher.
  try {
    transporte.Verificar();
    logger.System(`Transporte de e-mail: ${transporte.Nome}`);
  } catch (erro) {
    logger.Warning(`[Email] ${(erro as Error).message}. Enquanto isso, todo pedido de envio será recusado.`);
  }
  if (config.Autorizacao.ModulosPermitidos.length === 0) {
    logger.Warning("[Email] Autorizacao.ModulosPermitidos está vazio: nenhum módulo poderá pedir envios.");
  }

  try {
    bd = await PrepararBanco(config);
  } catch (erro) {
    logger.Error("Ao preparar o banco de dados:", Descrever_Erro(erro, segredos));
    await Encerrar(1);
    return;
  }

  const dados = new Modulos_Struct();
  dados.Modulo_Nome = config.modulo.nome;
  dados.Modulo_Versao = config.modulo.versao;
  core = new Socket_Client({
    host: config.Core.Host,
    porta: Number(config.Core.Porta),
    segredo: String(config.Core.Segredo ?? ""),
    timeoutMs: Number(config.Core.TimeoutMs),
  }, dados);

  const limitador = new Limitador_Taxa(
    Number(config.RateLimit.JanelaSegundos) * 1000,
    Number(config.RateLimit.MaximoPorModulo),
    Number(config.RateLimit.MaximoGlobal),
  );
  const templates = new Templates_Email(NaRaiz(config.Email.PastaTemplates));
  const servico = new Config_Email(config, bd, transporte, templates, limitador);
  const autorizacao = new Autorizacao_Email(config.Autorizacao, new Resolvedor_Modulos_Core(core), new Autenticador_Cliente(core));

  // Listeners antes da conexão: nenhum pacote chega sem handler
  new Socket_Email(core, servico, autorizacao, segredos).Registrar();

  // Se o Core estiver fora, continua tentando; refaz o registro a cada reconexão
  await core.Connect();
  logger.System(`${dados.Modulo_Nome} conectado ao Core`);
}

void iniciar();
