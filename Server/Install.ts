import { Cadastro_Dados_Banco } from "./Controllers/Cadastro_Dados_Banco";
import { Conector_Mysql } from "./Controllers/Lib/Conector_Mysql";
import { Logger } from "./Controllers/Lib/Logger";
import { Carregar_Configuracao } from "./Controllers/Lib/Configuracao";
import { Descrever_Erro } from "./Controllers/Lib/Erros";

/**
 * Instalação/atualização manual do banco: `npm run setup`.
 * A inicialização normal do módulo já faz o mesmo a cada subida.
 */
const logger = new Logger();

async function instalar(): Promise<void> {
  const config = Carregar_Configuracao();
  const bd = new Conector_Mysql({ user: config.BD.Usuario, password: config.BD.Senha, database: config.BD.Database, host: config.BD.Host, port: config.BD.Porta });
  try {
    await bd.Testar();
    const banco = new Cadastro_Dados_Banco(bd);
    await banco.Inicializar_Tabelas();
    await banco.Inicializar_Permissoes();
    logger.System("Tabelas e permissões do WS-Core_Email atualizadas");
  } finally {
    await bd.Fechar();
  }
}

void instalar().catch((error: unknown) => { logger.Error("Falha na instalação/atualização do WS-Core_Email", Descrever_Erro(error)); process.exitCode = 1; });
