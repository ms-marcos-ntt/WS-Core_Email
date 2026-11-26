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
    await this.Atualizar_Colunas();
  }

  /**
   * Bancos criados na versão 0.1.0 não têm `qtd_destinatarios`/`qtd_aceitos` (usadas pelo cálculo de
   * consumo). Adiciona as colunas e preenche os registros antigos: destinatários = para+cc+bcc
   * (contados pelas vírgulas, o módulo grava separados por ", ") e aceitos = destinatários nos já enviados.
   * Só roda quando a coluna ainda não existe (portável: MySQL e MariaDB).
   */
  public async Atualizar_Colunas(): Promise<void> {
    const colunas = await this.bd.Query<{ COLUMN_NAME: string }>(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_Core_Email_Envios'");
    if (colunas.some((c) => c.COLUMN_NAME === "qtd_destinatarios")) return;
    await this.bd.Executar("ALTER TABLE _Core_Email_Envios ADD COLUMN qtd_destinatarios INT UNSIGNED NOT NULL DEFAULT 0 AFTER tamanho_bytes, ADD COLUMN qtd_aceitos INT UNSIGNED NOT NULL DEFAULT 0 AFTER qtd_destinatarios");
    const contar = (c: string) => `(CHAR_LENGTH(${c}) - CHAR_LENGTH(REPLACE(${c}, ',', '')) + 1)`;
    await this.bd.Executar(`UPDATE _Core_Email_Envios SET qtd_destinatarios = ${contar("para")} + IF(cc IS NULL, 0, ${contar("cc")}) + IF(bcc IS NULL, 0, ${contar("bcc")})`);
    await this.bd.Executar("UPDATE _Core_Email_Envios SET qtd_aceitos = qtd_destinatarios WHERE status = 'enviado'");
    this.logger.System("[Email] Colunas qtd_destinatarios/qtd_aceitos adicionadas e preenchidas em _Core_Email_Envios.");
  }

  /**
   * data_*.sql: permissões e menu no Autenticador (idempotentes). Se o Autenticador ainda não criou a tabela
   * `_Permissoes` neste banco, avisa e segue: sem isso a tela não aparece no menu e as permissões da tela não existem.
   */
  public async Inicializar_Permissoes(): Promise<void> {
    const files = fs.readdirSync(PASTA_SQL).filter((file) => /^data_.*\.sql$/i.test(file)).sort();
    for (const file of files) {
      try {
        await this.bd.ExecutarScript(fs.readFileSync(path.join(PASTA_SQL, file), "utf8"));
      } catch (erro) {
        if ((erro as { code?: string }).code === "ER_NO_SUCH_TABLE") {
          this.logger.Warning(`[Email] ${file} não aplicado: tabela _Permissoes/_Menus inexistente (suba o WS-Core_Autenticador e rode "npm run setup" depois).`);
          continue;
        }
        throw erro;
      }
    }
  }
}
