/**
 * Relógio do módulo no fuso America/Sao_Paulo.
 *
 * "Hoje" e "mês" dos limites e do painel valem no horário de Brasília, não no do servidor nem
 * no do banco. Por isso o módulo grava `criado_em`/`concluido_em` e calcula todos os limites
 * de período aqui, sempre como texto "AAAA-MM-DD HH:MM:SS.mmm" no horário de São Paulo
 * (a conexão com o banco devolve DATETIME como texto, sem conversão de fuso).
 */

export const FUSO = "America/Sao_Paulo";

const FORMATADOR = new Intl.DateTimeFormat("en-CA", {
  timeZone: FUSO, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

interface Partes { ano: string; mes: string; dia: string; hora: string; minuto: string; segundo: string }

function PartesSP(data: Date): Partes {
  const p: Record<string, string> = {};
  for (const parte of FORMATADOR.formatToParts(data)) p[parte.type] = parte.value;
  return { ano: p.year, mes: p.month, dia: p.day, hora: p.hour, minuto: p.minute, segundo: p.second };
}

/** "AAAA-MM-DD HH:MM:SS.mmm" no horário de São Paulo. */
export function Formatar_SP(data: Date): string {
  const p = PartesSP(data);
  return `${p.ano}-${p.mes}-${p.dia} ${p.hora}:${p.minuto}:${p.segundo}.${String(data.getUTCMilliseconds()).padStart(3, "0")}`;
}

export class Relogio {
  public constructor(private readonly agora: () => Date = () => new Date()) {}

  /** Instante atual (para gravar criado_em/concluido_em). */
  public Agora(): string { return Formatar_SP(this.agora()); }

  /** Há `minutos` minutos. */
  public MinutosAtras(minutos: number): string { return Formatar_SP(new Date(this.agora().getTime() - minutos * 60_000)); }

  /** Dia de hoje: "AAAA-MM-DD". */
  public Hoje(): string {
    const p = PartesSP(this.agora());
    return `${p.ano}-${p.mes}-${p.dia}`;
  }

  /** Meia-noite de hoje. */
  public InicioDoDia(): string { return `${this.Hoje()} 00:00:00.000`; }

  /** Meia-noite do dia 1 do mês atual. */
  public InicioDoMes(): string {
    const p = PartesSP(this.agora());
    return `${p.ano}-${p.mes}-01 00:00:00.000`;
  }

  /** Os últimos `n` dias (o último é hoje), em ordem crescente: ["AAAA-MM-DD", ...]. */
  public UltimosDias(n: number): string[] {
    const [a, m, d] = this.Hoje().split("-").map(Number);
    const dias: string[] = [];
    for (let i = n - 1; i >= 0; i--) dias.push(new Date(Date.UTC(a, m - 1, d - i)).toISOString().slice(0, 10));
    return dias;
  }

  /** Meia-noite do primeiro dos últimos `n` dias. */
  public InicioDosUltimosDias(n: number): string { return `${this.UltimosDias(n)[0]} 00:00:00.000`; }
}

/** Dia seguinte a "AAAA-MM-DD" (para filtros "até" inclusivos). */
export function DiaSeguinte(dia: string): string {
  const [a, m, d] = dia.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** true se for uma data real "AAAA-MM-DD". */
export function DiaValido(dia: unknown): dia is string {
  if (typeof dia !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dia)) return false;
  const [a, m, d] = dia.split("-").map(Number);
  const data = new Date(Date.UTC(a, m - 1, d));
  return data.getUTCFullYear() === a && data.getUTCMonth() === m - 1 && data.getUTCDate() === d;
}
