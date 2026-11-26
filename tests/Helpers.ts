import Modelo_Config_JSON from "../Server/Models/Modelo_Config_JSON.json";
import { Modelo_Configuracao } from "../Server/Models/Modelo_Configuracao";
import { Mesclar_Com_Padrao } from "../Server/Controllers/Lib/Configuracao";
import { Logger } from "../Server/Controllers/Lib/Logger";

Logger.Configurar({ Console: false, Arquivo: false });

/** Config padrão do modelo, com transporte simulado e as sobreposições informadas. */
export function Config_Teste(extra: Record<string, unknown> = {}): Modelo_Configuracao {
  const base = JSON.parse(JSON.stringify(Modelo_Config_JSON)) as Record<string, unknown>;
  return Mesclar_Com_Padrao({ SMTP: { Modo: "simulado" }, ...extra }, base) as unknown as Modelo_Configuracao;
}

export interface Chamada_Banco { sql: string; valores: unknown[] }

/** Banco em memória: guarda as chamadas e devolve insertId crescente. Pode ser forçado a falhar. */
export class Banco_Falso {
  public readonly chamadas: Chamada_Banco[] = [];
  /** Respostas roteiradas de Query: a primeira cujo padrão casar com o SQL. */
  public respostas: Array<{ padrao: RegExp; linhas: any[] }> = [];
  public falharInsert = false;
  public falharUpdate = false;
  private proximoId = 1;

  public async Executar(sql: string, valores: unknown[] = []): Promise<any> {
    this.chamadas.push({ sql, valores });
    if (/^\s*INSERT/i.test(sql)) {
      if (this.falharInsert) throw Object.assign(new Error("banco fora"), { code: "ECONNREFUSED", sqlMessage: "x", sql });
      return { insertId: this.proximoId++ };
    }
    if (/^\s*UPDATE/i.test(sql) && this.falharUpdate) throw new Error("banco fora");
    return { affectedRows: 1 };
  }

  public async Query(sql: string, valores: unknown[] = []): Promise<any[]> {
    this.chamadas.push({ sql, valores });
    const roteirada = this.respostas.find((r) => r.padrao.test(sql));
    return roteirada ? roteirada.linhas : [{ 1: 1 }];
  }

  public get inserts(): Chamada_Banco[] { return this.chamadas.filter((c) => /^\s*INSERT/i.test(c.sql)); }
  public get updates(): Chamada_Banco[] { return this.chamadas.filter((c) => /^\s*UPDATE/i.test(c.sql)); }
}
