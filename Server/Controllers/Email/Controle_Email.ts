import { Erro_Email } from "../../Models/Email/Tipos";
import { Conector_Mysql } from "../Lib/Conector_Mysql";
import { Logger } from "../Lib/Logger";
import { Relogio } from "./Relogio_Email";
import { Consultar_Consumo } from "./Uso_Email";

/**
 * Controle de envio guardado no banco (`_Core_Email_Configuracao`): limite diário, limite mensal,
 * % de alerta e chave "pausar envios". Vale para o módulo todo (não por módulo solicitante).
 * Os limites do config.cfg (RateLimit, Email.Limites) continuam valendo à parte e não passam por aqui.
 */

export interface Controle {
  /** 0 = sem limite */
  limiteDiario: number;
  /** 0 = sem limite */
  limiteMensal: number;
  /** 1..100 */
  percentualAlerta: number;
  pausado: boolean;
  alteradoPor: number | null;
  alteradoEm: string | null;
}

export const PADRAO_CONTROLE: Pick<Controle, "limiteDiario" | "limiteMensal" | "percentualAlerta" | "pausado"> = {
  limiteDiario: 0, limiteMensal: 0, percentualAlerta: 80, pausado: false,
};

/** Tetos da validação (proteção contra digitação errada; o SES não passa disso na prática). */
export const TETO_LIMITE_DIARIO = 1_000_000;
export const TETO_LIMITE_MENSAL = 10_000_000;

export type Alteracao_Controle = Partial<Pick<Controle, "limiteDiario" | "limiteMensal" | "percentualAlerta" | "pausado">>;

const CHAVES: Record<keyof typeof PADRAO_CONTROLE, string> = {
  limiteDiario: "limite_diario", limiteMensal: "limite_mensal", percentualAlerta: "percentual_alerta", pausado: "pausado",
};

function Falha(mensagem: string): never {
  throw new Erro_Email("validacao", mensagem);
}

function LerInteiro(valor: unknown, campo: string, minimo: number, maximo: number): number {
  if (typeof valor !== "number" || !Number.isInteger(valor)) Falha(`"${campo}" deve ser um número inteiro`);
  if (valor < minimo || valor > maximo) Falha(`"${campo}" deve estar entre ${minimo} e ${maximo.toLocaleString("pt-BR")}`);
  return valor;
}

/**
 * Valida o formulário de limites. Campos opcionais (o que não vier fica como está), mas ao menos um é
 * obrigatório; campo desconhecido é recusado. Inteiros, sem texto: diário 0..1.000.000, mensal 0..10.000.000
 * (0 = sem limite), alerta 1..100, pausado booleano.
 */
export function Validar_Alteracao_Controle(dados: unknown): Alteracao_Controle {
  if (dados === null || typeof dados !== "object" || Array.isArray(dados)) Falha("Pacote inválido: esperado um objeto JSON");
  const d = dados as Record<string, unknown>;
  for (const chave of Object.keys(d)) if (!(chave in PADRAO_CONTROLE)) Falha(`Campo desconhecido: "${chave}"`);
  const r: Alteracao_Controle = {};
  if (d.limiteDiario !== undefined) r.limiteDiario = LerInteiro(d.limiteDiario, "limiteDiario", 0, TETO_LIMITE_DIARIO);
  if (d.limiteMensal !== undefined) r.limiteMensal = LerInteiro(d.limiteMensal, "limiteMensal", 0, TETO_LIMITE_MENSAL);
  if (d.percentualAlerta !== undefined) r.percentualAlerta = LerInteiro(d.percentualAlerta, "percentualAlerta", 1, 100);
  if (d.pausado !== undefined) {
    if (typeof d.pausado !== "boolean") Falha(`"pausado" deve ser verdadeiro ou falso`);
    r.pausado = d.pausado;
  }
  if (Object.keys(r).length === 0) Falha("Informe ao menos um campo: limiteDiario, limiteMensal, percentualAlerta ou pausado");
  return r;
}

/** Os dois limites juntos precisam fazer sentido: diário maior que o mensal nunca seria atingido. */
export function Validar_Coerencia(c: Pick<Controle, "limiteDiario" | "limiteMensal">): void {
  if (c.limiteDiario > 0 && c.limiteMensal > 0 && c.limiteDiario > c.limiteMensal) {
    Falha("O limite diário não pode ser maior que o limite mensal");
  }
}

export interface Registro_Historico_Controle { id: number; chave: string; antes: string | null; depois: string | null; alteradoPor: number | null; alteradoEm: string }

type Banco = Pick<Conector_Mysql, "Query" | "Executar">;

const inteiroLido = (v: unknown, padrao: number, minimo: number, maximo: number): number => {
  const n = typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= minimo && n <= maximo ? n : padrao;
};

export class Servico_Controle {
  private readonly logger = new Logger();

  public constructor(private readonly bd: Banco, private readonly relogio: Relogio) {}

  /** Controle atual (valores ausentes ou corrompidos no banco voltam ao padrão: sem limite, alerta 80%, sem pausa). */
  public async Obter(): Promise<Controle> {
    const linhas = await this.bd.Query<{ chave: string; valor: unknown; alterado_por: unknown; alterado_em: unknown }>(
      "SELECT chave, valor, alterado_por, alterado_em FROM _Core_Email_Configuracao");
    const por = new Map(linhas.map((l) => [String(l.chave), l]));
    const valor = (k: keyof typeof CHAVES) => por.get(CHAVES[k])?.valor;
    let ultimo: { por: number | null; em: string } | null = null;
    for (const l of linhas) {
      const em = l.alterado_em == null ? "" : String(l.alterado_em);
      if (em !== "" && (ultimo === null || em > ultimo.em)) ultimo = { em, por: l.alterado_por == null ? null : Number(l.alterado_por) };
    }
    return {
      limiteDiario: inteiroLido(valor("limiteDiario"), PADRAO_CONTROLE.limiteDiario, 0, TETO_LIMITE_DIARIO),
      limiteMensal: inteiroLido(valor("limiteMensal"), PADRAO_CONTROLE.limiteMensal, 0, TETO_LIMITE_MENSAL),
      percentualAlerta: inteiroLido(valor("percentualAlerta"), PADRAO_CONTROLE.percentualAlerta, 1, 100),
      pausado: String(valor("pausado") ?? "0") === "1",
      alteradoPor: ultimo?.por ?? null,
      alteradoEm: ultimo?.em ?? null,
    };
  }

  /**
   * Aplica a alteração (já validada por Validar_Alteracao_Controle), gravando cada mudança em
   * `_Core_Email_Configuracao_Historico` ANTES de alterar o valor: se a auditoria falhar, nada muda.
   * Só valores que realmente mudaram geram registro. Nada aqui é segredo (só números e a chave de pausa).
   */
  public async Alterar(usuarioId: number, dados: unknown): Promise<{ controle: Controle; alterados: string[] }> {
    const pedido = Validar_Alteracao_Controle(dados);
    const atual = await this.Obter();
    const novo = { ...atual, ...pedido };
    Validar_Coerencia(novo);

    const agora = this.relogio.Agora();
    const alterados: string[] = [];
    for (const campo of Object.keys(pedido) as Array<keyof typeof CHAVES>) {
      if (pedido[campo] === atual[campo]) continue;
      const antes = this.Texto(campo, atual[campo]);
      const depois = this.Texto(campo, novo[campo]);
      await this.bd.Executar(
        "INSERT INTO _Core_Email_Configuracao_Historico (chave, valor_antes, valor_depois, alterado_por, alterado_em) VALUES (?,?,?,?,?)",
        [CHAVES[campo], antes, depois, usuarioId, agora]);
      await this.bd.Executar(
        `INSERT INTO _Core_Email_Configuracao (chave, valor, alterado_por, alterado_em) VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE valor = VALUES(valor), alterado_por = VALUES(alterado_por), alterado_em = VALUES(alterado_em)`,
        [CHAVES[campo], depois, usuarioId, agora]);
      this.logger.System(`[Email] Controle alterado pelo usuário #${usuarioId}: ${CHAVES[campo]} ${antes} -> ${depois}`);
      alterados.push(CHAVES[campo]);
    }
    return { controle: await this.Obter(), alterados };
  }

  private Texto(campo: keyof typeof CHAVES, valor: unknown): string {
    return campo === "pausado" ? (valor ? "1" : "0") : String(valor);
  }

  /** Últimas alterações de limite/pausa (mais recentes primeiro). */
  public async Historico(limite = 10): Promise<Registro_Historico_Controle[]> {
    const linhas = await this.bd.Query<Record<string, unknown>>(
      "SELECT id, chave, valor_antes, valor_depois, alterado_por, alterado_em FROM _Core_Email_Configuracao_Historico ORDER BY id DESC LIMIT ?",
      [Math.max(1, Math.min(50, Math.trunc(limite)))]);
    return linhas.map((l) => ({
      id: Number(l.id), chave: String(l.chave), antes: l.valor_antes == null ? null : String(l.valor_antes),
      depois: l.valor_depois == null ? null : String(l.valor_depois), alteradoPor: l.alterado_por == null ? null : Number(l.alterado_por), alteradoEm: String(l.alterado_em ?? ""),
    }));
  }

  /**
   * Barreira do envio. Lança Erro_Email com código:
   *  - `pausado`        chave "pausar envios" ligada;
   *  - `limite_diario`  consumo de hoje + destinatários do pedido passaria do limite diário;
   *  - `limite_mensal`  idem para o mês.
   * Nada é enviado nem registrado quando lança. Sem limite configurado e sem pausa, não consulta o consumo.
   */
  public async Verificar_Envio(destinatarios: number): Promise<void> {
    const c = await this.Obter();
    if (c.pausado) throw new Erro_Email("pausado", "Envio de e-mails pausado pelo administrador do WS-Core_Email. Tente novamente depois que a pausa for desligada");
    if (c.limiteDiario === 0 && c.limiteMensal === 0) return;
    const consumo = await Consultar_Consumo(this.bd, this.relogio);
    if (c.limiteDiario > 0 && consumo.hoje + destinatarios > c.limiteDiario) {
      throw new Erro_Email("limite_diario",
        `Limite diário de envios atingido (${consumo.hoje} de ${c.limiteDiario} destinatários usados hoje; este pedido tem ${destinatarios}). Volta a liberar à meia-noite (horário de Brasília) ou quando o limite for aumentado`);
    }
    if (c.limiteMensal > 0 && consumo.mes + destinatarios > c.limiteMensal) {
      throw new Erro_Email("limite_mensal",
        `Limite mensal de envios atingido (${consumo.mes} de ${c.limiteMensal} destinatários usados no mês; este pedido tem ${destinatarios}). Volta a liberar no dia 1º do próximo mês ou quando o limite for aumentado`);
    }
  }
}
