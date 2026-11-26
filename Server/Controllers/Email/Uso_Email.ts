import { Conector_Mysql } from "../Lib/Conector_Mysql";
import { Relogio } from "./Relogio_Email";

/**
 * Consumo de cota e painel de uso.
 *
 * REGRA DE CONSUMO (a unidade é o DESTINATÁRIO aceito, como a cota do AWS SES):
 *  - `enviado`: conta `qtd_aceitos` (destinatários que o servidor SMTP aceitou; uma mensagem para
 *    3 pessoas consome 3, e se 1 for recusado pelo servidor consome 2);
 *  - `falhou`: NÃO conta (nada foi entregue ao servidor);
 *  - `enviando`: conta `qtd_destinatarios` como reserva enquanto o envio está em andamento (para dois
 *    pedidos simultâneos não estourarem o limite), mas só até 10 minutos — registro "enviando" mais
 *    velho que isso é de um processo que caiu no meio e deixa de contar;
 *  - pedidos recusados antes de chegar ao SMTP (validação, autorização, rate limit, limite, pausa)
 *    não entram na tabela nem no consumo.
 */

/** Minutos que um envio "enviando" segura cota antes de ser considerado abandonado. */
export const MINUTOS_RESERVA = 10;

export interface Consumo { hora: number; hoje: number; mes: number }

export type Faixa = "sem_limite" | "normal" | "alerta" | "esgotado";

export interface Medidor {
  usado: number;
  /** 0 = sem limite */
  limite: number;
  /** null quando não há limite; arredondado a 1 casa; pode passar de 100 */
  percentual: number | null;
  faixa: Faixa;
}

/**
 * Faixas: `normal` (abaixo do % de alerta), `alerta` (do % de alerta até antes de 100%),
 * `esgotado` (100% ou mais — o envio é bloqueado) e `sem_limite` (limite 0).
 */
export function Calcular_Medidor(usado: number, limite: number, percentualAlerta: number): Medidor {
  if (!(limite > 0)) return { usado, limite: 0, percentual: null, faixa: "sem_limite" };
  const percentual = Math.round((usado / limite) * 1000) / 10;
  const faixa: Faixa = usado >= limite ? "esgotado" : percentual >= percentualAlerta ? "alerta" : "normal";
  return { usado, limite, percentual, faixa };
}

export interface Aviso { codigo: "pausado" | "diario_esgotado" | "mensal_esgotado" | "diario_alerta" | "mensal_alerta"; nivel: "erro" | "aviso"; mensagem: string }

export function Montar_Avisos(diario: Medidor, mensal: Medidor, pausado: boolean, percentualAlerta: number): Aviso[] {
  const avisos: Aviso[] = [];
  if (pausado) avisos.push({ codigo: "pausado", nivel: "erro", mensagem: "Os envios estão PAUSADOS: nenhum e-mail sai até a pausa ser desligada." });
  const texto = (m: Medidor, nome: string) => `Limite ${nome}: ${m.usado} de ${m.limite} destinatários (${m.percentual}%)`;
  if (diario.faixa === "esgotado") avisos.push({ codigo: "diario_esgotado", nivel: "erro", mensagem: `${texto(diario, "diário")} — esgotado: os envios estão bloqueados até a meia-noite (horário de Brasília).` });
  else if (diario.faixa === "alerta") avisos.push({ codigo: "diario_alerta", nivel: "aviso", mensagem: `${texto(diario, "diário")} — acima do alerta de ${percentualAlerta}%.` });
  if (mensal.faixa === "esgotado") avisos.push({ codigo: "mensal_esgotado", nivel: "erro", mensagem: `${texto(mensal, "mensal")} — esgotado: os envios estão bloqueados até o dia 1º do próximo mês.` });
  else if (mensal.faixa === "alerta") avisos.push({ codigo: "mensal_alerta", nivel: "aviso", mensagem: `${texto(mensal, "mensal")} — acima do alerta de ${percentualAlerta}%.` });
  return avisos;
}

type Banco = Pick<Conector_Mysql, "Query">;

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Consumo da última hora, de hoje e do mês (regra no topo deste arquivo). */
export async function Consultar_Consumo(bd: Banco, relogio: Relogio): Promise<Consumo> {
  const hora = relogio.MinutosAtras(60);
  const dia = relogio.InicioDoDia();
  const mes = relogio.InicioDoMes();
  const reserva = relogio.MinutosAtras(MINUTOS_RESERVA);
  const maisAntigo = [hora, dia, mes].sort()[0];
  const efetivo = "CASE WHEN status = 'enviado' THEN qtd_aceitos WHEN status = 'enviando' AND criado_em >= ? THEN qtd_destinatarios ELSE 0 END";
  const linhas = await bd.Query<{ hora: unknown; hoje: unknown; mes: unknown }>(
    `SELECT COALESCE(SUM(CASE WHEN criado_em >= ? THEN ${efetivo} ELSE 0 END), 0) AS hora,
            COALESCE(SUM(CASE WHEN criado_em >= ? THEN ${efetivo} ELSE 0 END), 0) AS hoje,
            COALESCE(SUM(CASE WHEN criado_em >= ? THEN ${efetivo} ELSE 0 END), 0) AS mes
       FROM _Core_Email_Envios WHERE criado_em >= ?`,
    [hora, reserva, dia, reserva, mes, reserva, maisAntigo],
  );
  const l = linhas[0] ?? {};
  return { hora: num(l.hora), hoje: num(l.hoje), mes: num(l.mes) };
}

export interface Linha_Modulo { modulo: string; mensagens: number; destinatariosAceitos: number; falhas: number }
export interface Linha_Status { status: string; mensagens: number; destinatarios: number }
export interface Ponto_Serie { dia: string; mensagens: number; destinatariosAceitos: number; falhas: number }
export interface Erro_Recente { id: number; criadoEm: string; modulo: string; codigo: string | null; referencia: string | null }

export interface Dados_Periodo {
  porModulo: Linha_Modulo[];
  porStatus: Linha_Status[];
  serie: Ponto_Serie[];
  taxaFalha: { falhas: number; finalizados: number; percentual: number | null };
  ultimosErros: Erro_Recente[];
}

/** Quebras do período (7 ou 30 dias, contando hoje): por módulo, por status, série diária, taxa de falha e últimos erros. */
export async function Consultar_Periodo(bd: Banco, relogio: Relogio, dias: 7 | 30): Promise<Dados_Periodo> {
  const inicio = relogio.InicioDosUltimosDias(dias);
  const reserva = relogio.MinutosAtras(MINUTOS_RESERVA);
  const aceitos = "CASE WHEN status = 'enviado' THEN qtd_aceitos WHEN status = 'enviando' AND criado_em >= ? THEN qtd_destinatarios ELSE 0 END";

  const [modulos, status, serie, erros] = await Promise.all([
    bd.Query<Record<string, unknown>>(
      `SELECT solicitante_modulo AS modulo, COUNT(*) AS mensagens, COALESCE(SUM(${aceitos}), 0) AS aceitos,
              COALESCE(SUM(status = 'falhou'), 0) AS falhas
         FROM _Core_Email_Envios WHERE criado_em >= ? GROUP BY solicitante_modulo ORDER BY aceitos DESC, modulo LIMIT 50`,
      [reserva, inicio]),
    bd.Query<Record<string, unknown>>(
      "SELECT status, COUNT(*) AS mensagens, COALESCE(SUM(qtd_destinatarios), 0) AS destinatarios FROM _Core_Email_Envios WHERE criado_em >= ? GROUP BY status",
      [inicio]),
    bd.Query<Record<string, unknown>>(
      `SELECT DATE(criado_em) AS dia, COUNT(*) AS mensagens, COALESCE(SUM(${aceitos}), 0) AS aceitos,
              COALESCE(SUM(status = 'falhou'), 0) AS falhas
         FROM _Core_Email_Envios WHERE criado_em >= ? GROUP BY DATE(criado_em)`,
      [reserva, inicio]),
    bd.Query<Record<string, unknown>>(
      `SELECT id, criado_em, solicitante_modulo, erro_codigo, referencia
         FROM _Core_Email_Envios WHERE status = 'falhou' ORDER BY id DESC LIMIT 10`),
  ]);

  const porDia = new Map(serie.map((l) => [String(l.dia).slice(0, 10), l]));
  const pontos: Ponto_Serie[] = relogio.UltimosDias(dias).map((dia) => {
    const l = porDia.get(dia);
    return { dia, mensagens: num(l?.mensagens), destinatariosAceitos: num(l?.aceitos), falhas: num(l?.falhas) };
  });

  const porStatus: Linha_Status[] = status.map((l) => ({ status: String(l.status), mensagens: num(l.mensagens), destinatarios: num(l.destinatarios) }));
  const falhas = num(porStatus.find((s) => s.status === "falhou")?.mensagens);
  const finalizados = falhas + num(porStatus.find((s) => s.status === "enviado")?.mensagens);

  return {
    porModulo: modulos.map((l) => ({ modulo: String(l.modulo), mensagens: num(l.mensagens), destinatariosAceitos: num(l.aceitos), falhas: num(l.falhas) })),
    porStatus,
    serie: pontos,
    taxaFalha: { falhas, finalizados, percentual: finalizados > 0 ? Math.round((falhas / finalizados) * 1000) / 10 : null },
    ultimosErros: erros.map((l) => ({ id: num(l.id), criadoEm: String(l.criado_em ?? ""), modulo: String(l.solicitante_modulo ?? ""), codigo: l.erro_codigo == null ? null : String(l.erro_codigo), referencia: l.referencia == null ? null : String(l.referencia) })),
  };
}
