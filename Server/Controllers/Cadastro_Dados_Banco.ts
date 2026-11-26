import * as fs from "fs";
import * as path from "path";
import { Conector_Mysql } from "./Lib/Conector_Mysql";
import { Logger } from "./Lib/Logger";
import { PASTA_SQL } from "./Lib/Configuracao";

export class Cadastro_Dados_Banco {
  private readonly logger = new Logger();

  public constructor(private readonly bd: Conector_Mysql) {}

  /** schema_*.sql (CREATE TABLE IF NOT EXISTS) — seguro rodar a cada inicialização. */
  public async Inicializar_Tabelas(): Promise<void> {
    const files = fs.readdirSync(PASTA_SQL).filter((file) => /^schema_.*\.sql$/i.test(file)).sort();
    for (const file of files) await this.bd.ExecutarScript(fs.readFileSync(path.join(PASTA_SQL, file), "utf8"));
  }

  /**
   * data_*.sql: permissões no Autenticador (idempotentes). Se o Autenticador ainda não criou a tabela
   * `_Permissoes` neste banco, avisa e segue: a permissão só é necessária com ExigirPermissaoUsuario.
   */
  public async Inicializar_Permissoes(): Promise<void> {
    const files = fs.readdirSync(PASTA_SQL).filter((file) => /^data_.*\.sql$/i.test(file)).sort();
    for (const file of files) {
      try {
        await this.bd.ExecutarScript(fs.readFileSync(path.join(PASTA_SQL, file), "utf8"));
      } catch (erro) {
        if ((erro as { code?: string }).code === "ER_NO_SUCH_TABLE") {
          this.logger.Warning(`[Email] ${file} não aplicado: tabela _Permissoes inexistente (suba o WS-Core_Autenticador e rode "npm run setup" depois).`);
          continue;
        }
        throw erro;
      }
    }
  }
}
