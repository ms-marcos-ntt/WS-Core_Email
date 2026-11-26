import { Erro_Email } from "../../Models/Email/Tipos";
import { Conector_Mysql } from "../Lib/Conector_Mysql";
import { DiaSeguinte, DiaValido } from "./Relogio_Email";

/**
 * Consulta do histórico (`_Core_Email_Envios`) para a tela. Tudo que vem da tela é validado e vai
 * para o SQL por parâmetro (`?`); o ORDER BY só usa colunas de uma lista fixa; nenhum texto da tela
 * é concatenado no SQL.
 */

export const STATUS_VALIDOS = ["enviado", "falhou", "enviando"] as const;

/** Chave da coluna na tela -> coluna do banco. Única fonte permitida para o ORDER BY. */
export const COLUNAS_ORDENAVEIS: Readonly<Record<string, string>> = Object.freeze({
  id: "id",
  criadoEm: "criado_em",
  modulo: "solicitante_modulo",
  referencia: "referencia",
  para: "para",
  assunto: "assunto",
  template: "template",
  status: "status",
  erroCodigo: "erro_codigo",
  tamanho: "tamanho_bytes",
  anexos: "qtd_anexos",
});

export const LIMITE_PADRAO = 50;
export const LIMITE_MAXIMO = 200;
export const PAGINA_MAXIMA = 100_000;
const MAX_BUSCA = 100;
const MAX_MODULO = 100;
/** Quantos caracteres de destinatários vão na listagem (o detalhe traz tudo). */
const RESUMO_DESTINATARIOS = 300;

export interface Filtros_Historico {
  busca?: string;
  status?: string;
  modulo?: string;
  /** AAAA-MM-DD, inclusivo */
  de?: string;
  /** AAAA-MM-DD, inclusivo */
  ate?: string;
  pagina: number;
  limite: number;
  ordem: string;
  direcao: "asc" | "desc";
}

function Falha(mensagem: string): never {
  throw new Erro_Email("validacao", mensagem);
}

function TextoOpcional(valor: unknown, campo: string, maximo: number): string | undefined {
  if (valor === undefined || valor === null || valor === "") return undefined;
  if (typeof valor !== "string") Falha(`Filtro "${campo}" inválido`);
  const texto = valor.trim();
  if (texto === "") return undefined;
  if (texto.length > maximo) Falha(`Filtro "${campo}" excede ${maximo} caracteres`);
  if (/[\u0000-\u001f\u007f]/.test(texto)) Falha(`Filtro "${campo}" contém caracteres inválidos`);
  return texto;
}

function Inteiro(valor: unknown, campo: string, padrao: number, minimo: number, maximo: number): number {
  if (valor === undefined || valor === null || valor === "") return padrao;
  const n = typeof valor === "string" && /^\d{1,9}$/.test(valor) ? Number(valor) : valor;
  if (typeof n !== "number" || !Number.isInteger(n)) Falha(`"${campo}" deve ser um número inteiro`);
  return Math.min(maximo, Math.max(minimo, n));
}

/** Valida e normaliza os parâmetros da listagem. Ordem desconhecida volta ao padrão (não vira erro nem SQL). */
export function Validar_Filtros(dados: unknown): Filtros_Historico {
  if (dados === null || dados === undefined) dados = {};
  if (typeof dados !== "object" || Array.isArray(dados)) Falha("Pacote inválido: esperado um objeto JSON");
  const d = dados as Record<string, unknown>;

  const status = TextoOpcional(d.status, "status", 20);
  if (status !== undefined && !(STATUS_VALIDOS as readonly string[]).includes(status)) Falha(`Status inválido (use ${STATUS_VALIDOS.join(", ")})`);

  const de = TextoOpcional(d.de, "de", 10);
  const ate = TextoOpcional(d.ate, "ate", 10);
  if (de !== undefined && !DiaValido(de)) Falha('Data inicial inválida (use AAAA-MM-DD)');
  if (ate !== undefined && !DiaValido(ate)) Falha('Data final inválida (use AAAA-MM-DD)');
  if (de !== undefined && ate !== undefined && de > ate) Falha("A data inicial não pode ser depois da final");

  const ordemPedida = typeof d.ordem === "string" ? d.ordem : "";
  const ordem = Object.prototype.hasOwnProperty.call(COLUNAS_ORDENAVEIS, ordemPedida) ? ordemPedida : "criadoEm";

  return {
    busca: TextoOpcional(d.busca, "busca", MAX_BUSCA),
    status,
    modulo: TextoOpcional(d.modulo, "modulo", MAX_MODULO),
    de, ate,
    pagina: Inteiro(d.pagina, "pagina", 1, 1, PAGINA_MAXIMA),
    limite: Inteiro(d.limite, "limite", LIMITE_PADRAO, 1, LIMITE_MAXIMO),
    ordem,
    direcao: String(d.direcao).toLowerCase() === "asc" ? "asc" : "desc",
  };
}

/** Escapa % _ \ para o texto digitado valer como texto literal no LIKE. */
export function Escapar_Like(texto: string): string {
  return texto.replace(/[\\%_]/g, (c) => "\\" + c);
}

const CAMPOS_BUSCA = ["solicitante_modulo", "referencia", "para", "cc", "bcc", "assunto", "template", "erro_codigo", "message_id"];

export interface Consulta { sql: string; params: unknown[]; sqlTotal: string; paramsTotal: unknown[] }

/** Monta o SELECT da página e o COUNT do total (mesmo WHERE). Função pura: não toca no banco. */
export function Montar_Consulta(f: Filtros_Historico): Consulta {
  const condicoes: string[] = [];
  const params: unknown[] = [];
  if (f.busca) {
    condicoes.push("(" + CAMPOS_BUSCA.map((c) => `${c} LIKE ?`).join(" OR ") + ")");
    const padrao = `%${Escapar_Like(f.busca)}%`;
    for (let i = 0; i < CAMPOS_BUSCA.length; i++) params.push(padrao);
  }
  if (f.status) { condicoes.push("status = ?"); params.push(f.status); }
  if (f.modulo) { condicoes.push("solicitante_modulo = ?"); params.push(f.modulo); }
  if (f.de) { condicoes.push("criado_em >= ?"); params.push(`${f.de} 00:00:00.000`); }
  if (f.ate) { condicoes.push("criado_em < ?"); params.push(`${DiaSeguinte(f.ate)} 00:00:00.000`); }
  const where = condicoes.length > 0 ? " WHERE " + condicoes.join(" AND ") : "";

  // `f.ordem` só pode ser uma chave de COLUNAS_ORDENAVEIS e `f.direcao` só asc/desc (ver Validar_Filtros);
  // mesmo assim o SQL só é montado a partir da tabela fixa, nunca do texto recebido.
  const coluna = COLUNAS_ORDENAVEIS[f.ordem] ?? COLUNAS_ORDENAVEIS.criadoEm;
  const direcao = f.direcao === "asc" ? "ASC" : "DESC";
  const offset = (f.pagina - 1) * f.limite;

  const sql = `SELECT id, criado_em, solicitante_modulo, referencia, LEFT(para, ${RESUMO_DESTINATARIOS}) AS para, qtd_destinatarios, assunto, template, qtd_anexos, tamanho_bytes, status, erro_codigo
    FROM _Core_Email_Envios${where} ORDER BY ${coluna} ${direcao}, id DESC LIMIT ? OFFSET ?`;
  return {
    sql, params: [...params, f.limite, offset],
    sqlTotal: `SELECT COUNT(*) AS total FROM _Core_Email_Envios${where}`, paramsTotal: params,
  };
}

type Banco = Pick<Conector_Mysql, "Query">;

export interface Item_Historico {
  id: number; criadoEm: string; modulo: string; referencia: string | null; para: string; qtdDestinatarios: number;
  assunto: string; template: string | null; anexos: number; tamanho: number; status: string; erroCodigo: string | null;
}

const texto = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export class Historico_Email {
  public constructor(private readonly bd: Banco) {}

  public async Listar(dados: unknown): Promise<{ items: Item_Historico[]; total: number }> {
    const consulta = Montar_Consulta(Validar_Filtros(dados));
    const [linhas, total] = await Promise.all([
      this.bd.Query<Record<string, unknown>>(consulta.sql, consulta.params),
      this.bd.Query<{ total: unknown }>(consulta.sqlTotal, consulta.paramsTotal),
    ]);
    return {
      total: Number(total[0]?.total ?? 0),
      items: linhas.map((l) => ({
        id: Number(l.id), criadoEm: String(l.criado_em ?? ""), modulo: String(l.solicitante_modulo ?? ""), referencia: texto(l.referencia),
        para: String(l.para ?? ""), qtdDestinatarios: Number(l.qtd_destinatarios ?? 0), assunto: String(l.assunto ?? ""), template: texto(l.template),
        anexos: Number(l.qtd_anexos ?? 0), tamanho: Number(l.tamanho_bytes ?? 0), status: String(l.status ?? ""), erroCodigo: texto(l.erro_codigo),
      })),
    };
  }

  /** Todos os campos de um envio (nunca o corpo da mensagem nem anexos: não são guardados). */
  public async Obter(dados: unknown): Promise<Record<string, unknown>> {
    const id = (dados as { id?: unknown } | null)?.id;
    const n = typeof id === "string" && /^\d{1,15}$/.test(id) ? Number(id) : id;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) Falha('Campo "id" inválido');
    const linhas = await this.bd.Query<Record<string, unknown>>(
      `SELECT id, criado_em, concluido_em, solicitante_modulo, usuario_id, referencia, para, cc, bcc, assunto, template, qtd_anexos, tamanho_bytes,
              qtd_destinatarios, qtd_aceitos, transporte, status, message_id, erro_codigo, erro
         FROM _Core_Email_Envios WHERE id = ?`, [n]);
    const l = linhas[0];
    if (!l) throw new Erro_Email("validacao", "Envio não encontrado");
    return {
      id: Number(l.id), criadoEm: texto(l.criado_em), concluidoEm: texto(l.concluido_em), modulo: String(l.solicitante_modulo ?? ""),
      usuarioId: l.usuario_id == null ? null : Number(l.usuario_id), referencia: texto(l.referencia), para: String(l.para ?? ""), cc: texto(l.cc), bcc: texto(l.bcc),
      assunto: String(l.assunto ?? ""), template: texto(l.template), anexos: Number(l.qtd_anexos ?? 0), tamanho: Number(l.tamanho_bytes ?? 0),
      qtdDestinatarios: Number(l.qtd_destinatarios ?? 0), qtdAceitos: Number(l.qtd_aceitos ?? 0), transporte: texto(l.transporte), status: String(l.status ?? ""),
      messageId: texto(l.message_id), erroCodigo: texto(l.erro_codigo), erro: texto(l.erro),
    };
  }

  /** Módulos que já pediram envios (para o filtro da tela) e os status possíveis. */
  public async Opcoes(): Promise<{ modulos: string[]; status: readonly string[] }> {
    const linhas = await this.bd.Query<{ m: unknown }>("SELECT DISTINCT solicitante_modulo AS m FROM _Core_Email_Envios ORDER BY solicitante_modulo LIMIT 200");
    return { modulos: linhas.map((l) => String(l.m)), status: STATUS_VALIDOS };
  }
}
