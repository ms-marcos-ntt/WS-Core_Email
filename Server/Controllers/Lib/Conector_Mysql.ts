import * as mysql from "mysql2/promise";

export interface DefinicaoTabela { nome: string; sql: string }
export type QueryRow = Record<string, unknown>;

/** Executor usado dentro de uma transação (mesma assinatura do Executar/Query do conector). */
export interface Transacao {
  Query<T = QueryRow>(sql: string, values?: unknown[]): Promise<T[]>;
  Executar(sql: string, values?: unknown[]): Promise<mysql.ResultSetHeader>;
}

/**
 * ⚠️ Colunas do tipo `JSON` (MariaDB) vêm **já deserializadas** em objeto/array JS através
 * deste driver — confirmado empiricamente em 2026-09-25 contra o servidor real. Nunca chame
 * `JSON.parse()` num valor lido de uma coluna JSON — isso já causou dois bugs reais (parse
 * silenciosamente falhando dentro de um try/catch, escondendo dados; e um "Unexpected end of
 * JSON input" não tratado). Tipar a coluna como o shape esperado (`Record<string,unknown>`,
 * `MinhaInterface[]`, etc.), nunca como `string`. Ao GRAVAR, continue usando
 * `JSON.stringify(valor)` no parâmetro — isso é necessário e correto.
 *
 * O pool do dia a dia NÃO aceita vários comandos numa só chamada (multipleStatements), para
 * que uma falha de SQL injection nunca vire execução de comandos extras. Arquivos .sql da
 * instalação, que têm vários comandos, passam por ExecutarScript (conexão separada).
 */
export class Conector_Mysql {
  private pool?: mysql.Pool;
  public constructor(private readonly credentials: mysql.PoolOptions) {}

  public async Conectar(): Promise<void> {
    // dateStrings: DATETIME volta como texto "AAAA-MM-DD HH:MM:SS.mmm", sem conversão de fuso
    // (o WS-Core_Email grava e consulta tudo no horário de São Paulo — ver Relogio_Email.ts).
    if (!this.pool) this.pool = mysql.createPool({ ...this.credentials, multipleStatements: false, dateStrings: true, waitForConnections: true, connectionLimit: 10, queueLimit: 0 });
  }

  public async Query<T = QueryRow>(sql: string, values: unknown[] = []): Promise<T[]> {
    await this.Conectar();
    const [rows] = await this.pool!.query(sql, values);
    return rows as T[];
  }

  public async Executar(sql: string, values: unknown[] = []): Promise<mysql.ResultSetHeader> {
    await this.Conectar();
    const [result] = await this.pool!.query(sql, values);
    return result as mysql.ResultSetHeader;
  }

  /** Confirma que o banco responde (o pool só abre conexões sob demanda). */
  public async Testar(): Promise<void> {
    await this.Query("SELECT 1");
  }

  /** Executa um arquivo .sql com vários comandos (instalação), numa conexão própria. */
  public async ExecutarScript(sql: string): Promise<void> {
    const conexao = await mysql.createConnection({ ...this.credentials, multipleStatements: true } as mysql.ConnectionOptions);
    try {
      await conexao.query(sql);
    } finally {
      await conexao.end();
    }
  }

  /**
   * Executa `fn` numa transação: tudo ou nada. Se `fn` lançar, desfaz o que foi feito.
   */
  public async Transacao<T>(fn: (tx: Transacao) => Promise<T>): Promise<T> {
    await this.Conectar();
    const conexao = await this.pool!.getConnection();
    try {
      await conexao.beginTransaction();
      const tx: Transacao = {
        Query: async <R = QueryRow>(sql: string, values: unknown[] = []) => (await conexao.query(sql, values))[0] as R[],
        Executar: async (sql: string, values: unknown[] = []) => (await conexao.query(sql, values))[0] as mysql.ResultSetHeader,
      };
      const resultado = await fn(tx);
      await conexao.commit();
      return resultado;
    } catch (erro) {
      await conexao.rollback().catch(() => undefined);
      throw erro;
    } finally {
      conexao.release();
    }
  }

  /** Encerra o pool (desligamento do processo). */
  public async Fechar(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    if (pool) await pool.end();
  }

  public async ValidarTabelas(tabelas: DefinicaoTabela[]): Promise<void> {
    for (const tabela of tabelas) await this.ExecutarScript(tabela.sql);
  }
}
