/**
 * Relógio de São Paulo, cálculo de uso/percentual, controle (limites, alerta, pausa) e sua aplicação no envio.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Banco_Falso, Config_Teste } from "./Helpers";
import { NaRaiz } from "../Server/Controllers/Lib/Configuracao";
import { Config_Email } from "../Server/Controllers/Email/Config_Email";
import { Servico_Controle, TETO_LIMITE_DIARIO, TETO_LIMITE_MENSAL, Validar_Alteracao_Controle } from "../Server/Controllers/Email/Controle_Email";
import { Limitador_Taxa } from "../Server/Controllers/Email/Limitador_Taxa";
import { DiaSeguinte, DiaValido, Relogio } from "../Server/Controllers/Email/Relogio_Email";
import { Templates_Email } from "../Server/Controllers/Email/Templates_Email";
import { Transporte_Simulado } from "../Server/Controllers/Email/Transporte_Email";
import { Calcular_Medidor, Consultar_Consumo, Consultar_Periodo, Montar_Avisos } from "../Server/Controllers/Email/Uso_Email";
import { Erro_Email } from "../Server/Models/Email/Tipos";

const relogioEm = (iso: string) => new Relogio(() => new Date(iso));

// ── Relógio ──────────────────────────────────────────────────────────────────────────

test("Relogio: tudo em horário de São Paulo (UTC-3), não no do servidor", () => {
  const r = relogioEm("2026-11-26T11:51:21.379Z");
  assert.equal(r.Agora(), "2026-11-26 08:51:21.379");
  assert.equal(r.Hoje(), "2026-11-26");
  assert.equal(r.InicioDoDia(), "2026-11-26 00:00:00.000");
  assert.equal(r.InicioDoMes(), "2026-11-01 00:00:00.000");
  assert.equal(r.MinutosAtras(60), "2026-11-26 07:51:21.379");
});

test("Relogio: virada de dia/mês acontece à meia-noite de Brasília, não à de UTC", () => {
  // 01/12 02:30 UTC ainda é 30/11 23:30 em São Paulo: continua no mês e no dia anteriores
  const antes = relogioEm("2026-12-01T02:30:00.000Z");
  assert.equal(antes.Hoje(), "2026-11-30");
  assert.equal(antes.InicioDoMes(), "2026-11-01 00:00:00.000");
  const depois = relogioEm("2026-12-01T03:00:00.000Z");
  assert.equal(depois.Hoje(), "2026-12-01");
  assert.equal(depois.InicioDoMes(), "2026-12-01 00:00:00.000");
  // 00:30 do dia 1º em SP: "última hora" volta para o mês anterior, o mês não
  assert.equal(relogioEm("2026-12-01T03:30:00.000Z").MinutosAtras(60), "2026-11-30 23:30:00.000");
});

test("Relogio: últimos N dias em ordem, cruzando mês e ano", () => {
  assert.deepEqual(relogioEm("2027-01-02T15:00:00Z").UltimosDias(4), ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
  assert.equal(relogioEm("2026-11-26T15:00:00Z").InicioDosUltimosDias(7), "2026-11-20 00:00:00.000");
  assert.equal(relogioEm("2026-11-26T15:00:00Z").UltimosDias(30).length, 30);
});

test("DiaSeguinte e DiaValido", () => {
  assert.equal(DiaSeguinte("2026-12-31"), "2027-01-01");
  assert.equal(DiaSeguinte("2028-02-28"), "2028-02-29");
  assert.equal(DiaValido("2026-02-29"), false);
  assert.equal(DiaValido("2028-02-29"), true);
  assert.equal(DiaValido("2026-13-01"), false);
  assert.equal(DiaValido("26-11-01"), false);
  assert.equal(DiaValido(20261101), false);
});

// ── Medidor, faixas e avisos ─────────────────────────────────────────────────────────

test("Calcular_Medidor: percentual e faixas (sem limite / normal / alerta / esgotado)", () => {
  assert.deepEqual(Calcular_Medidor(500, 0, 80), { usado: 500, limite: 0, percentual: null, faixa: "sem_limite" });
  assert.deepEqual(Calcular_Medidor(0, 100, 80), { usado: 0, limite: 100, percentual: 0, faixa: "normal" });
  assert.equal(Calcular_Medidor(79, 100, 80).faixa, "normal");
  assert.equal(Calcular_Medidor(80, 100, 80).faixa, "alerta", "no % de alerta exato já é alerta");
  assert.equal(Calcular_Medidor(99, 100, 80).faixa, "alerta");
  assert.equal(Calcular_Medidor(100, 100, 80).faixa, "esgotado");
  const passou = Calcular_Medidor(130, 100, 80);
  assert.deepEqual([passou.faixa, passou.percentual], ["esgotado", 130]);
  assert.equal(Calcular_Medidor(1, 3, 80).percentual, 33.3, "1 casa decimal");
  assert.equal(Calcular_Medidor(99, 100, 100).faixa, "normal", "alerta em 100% só dispara no esgotamento");
});

test("Montar_Avisos: pausa, esgotado e alerta, diário e mensal", () => {
  const normal = Calcular_Medidor(10, 100, 80);
  assert.deepEqual(Montar_Avisos(normal, normal, false, 80), []);
  const semLimite = Calcular_Medidor(10, 0, 80);
  assert.deepEqual(Montar_Avisos(semLimite, semLimite, false, 80), []);
  assert.deepEqual(Montar_Avisos(normal, normal, true, 80).map((a) => [a.codigo, a.nivel]), [["pausado", "erro"]]);
  const avisos = Montar_Avisos(Calcular_Medidor(85, 100, 80), Calcular_Medidor(1000, 1000, 80), false, 80);
  assert.deepEqual(avisos.map((a) => [a.codigo, a.nivel]), [["diario_alerta", "aviso"], ["mensal_esgotado", "erro"]]);
  assert.match(avisos[0].mensagem, /85 de 100 destinatários \(85%\).*alerta de 80%/);
});

// ── Consumo e período (SQL com parâmetros, regra de contagem) ─────────────────────────

test("Consultar_Consumo: lê hora/hoje/mês com os limites de período em horário de SP e a regra de reserva", async () => {
  const bd = new Banco_Falso();
  bd.respostas.push({ padrao: /SUM\(CASE WHEN criado_em/, linhas: [{ hora: "3", hoje: "12", mes: "40" }] });
  const c = await Consultar_Consumo(bd, relogioEm("2026-11-26T11:51:21.379Z"));
  assert.deepEqual(c, { hora: 3, hoje: 12, mes: 40 });
  const q = bd.chamadas.find((x) => /SUM\(CASE/.test(x.sql))!;
  // Regra: só 'enviado' (qtd_aceitos) e a reserva de 'enviando' recente (qtd_destinatarios); 'falhou' não conta
  assert.match(q.sql, /WHEN status = 'enviado' THEN qtd_aceitos/);
  assert.match(q.sql, /WHEN status = 'enviando' AND criado_em >= \? THEN qtd_destinatarios/);
  assert.doesNotMatch(q.sql, /falhou/);
  assert.deepEqual(q.valores, [
    "2026-11-26 07:51:21.379", "2026-11-26 08:41:21.379", // última hora + reserva de 10 min
    "2026-11-26 00:00:00.000", "2026-11-26 08:41:21.379", // hoje
    "2026-11-01 00:00:00.000", "2026-11-26 08:41:21.379", // mês
    "2026-11-01 00:00:00.000",                             // WHERE: o mais antigo dos três
  ]);
});

test("Consultar_Consumo: banco vazio ou valores estranhos viram 0", async () => {
  const bd = new Banco_Falso();
  bd.respostas.push({ padrao: /SUM/, linhas: [{ hora: null, hoje: "abc", mes: undefined }] });
  assert.deepEqual(await Consultar_Consumo(bd, relogioEm("2026-11-26T11:00:00Z")), { hora: 0, hoje: 0, mes: 0 });
});

test("Consultar_Periodo: completa os dias sem envio, calcula taxa de falha e mapeia erros", async () => {
  const bd = new Banco_Falso();
  bd.respostas.push(
    { padrao: /GROUP BY solicitante_modulo/, linhas: [{ modulo: "WSMod_FibraMap", mensagens: "5", aceitos: "9", falhas: "1" }] },
    { padrao: /GROUP BY status/, linhas: [{ status: "enviado", mensagens: "4", destinatarios: "9" }, { status: "falhou", mensagens: "1", destinatarios: "1" }] },
    { padrao: /GROUP BY DATE\(criado_em\)/, linhas: [{ dia: "2026-11-24", mensagens: "2", aceitos: "3", falhas: "0" }, { dia: "2026-11-26", mensagens: "3", aceitos: "6", falhas: "1" }] },
    { padrao: /status = 'falhou'/, linhas: [{ id: 9, criado_em: "2026-11-26 08:00:00.000", solicitante_modulo: "WSMod_FibraMap", erro_codigo: "smtp_timeout", referencia: null }] },
  );
  const p = await Consultar_Periodo(bd, relogioEm("2026-11-26T15:00:00Z"), 7);
  assert.equal(p.serie.length, 7);
  assert.deepEqual(p.serie.map((s) => s.dia), ["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26"]);
  assert.deepEqual(p.serie[4], { dia: "2026-11-24", mensagens: 2, destinatariosAceitos: 3, falhas: 0 });
  assert.deepEqual(p.serie[5], { dia: "2026-11-25", mensagens: 0, destinatariosAceitos: 0, falhas: 0 });
  assert.deepEqual(p.taxaFalha, { falhas: 1, finalizados: 5, percentual: 20 });
  assert.deepEqual(p.porModulo, [{ modulo: "WSMod_FibraMap", mensagens: 5, destinatariosAceitos: 9, falhas: 1 }]);
  assert.deepEqual(p.ultimosErros, [{ id: 9, criadoEm: "2026-11-26 08:00:00.000", modulo: "WSMod_FibraMap", codigo: "smtp_timeout", referencia: null }]);
  // todas as consultas do período usam parâmetros (nada de texto concatenado) e o início da janela de 7 dias
  assert.ok(bd.chamadas.filter((c) => /GROUP BY/.test(c.sql)).every((c) => c.valores.includes("2026-11-20 00:00:00.000")));
});

test("Consultar_Periodo: sem envios finalizados a taxa de falha é nula (não 0%)", async () => {
  const p = await Consultar_Periodo(new Banco_Falso(), relogioEm("2026-11-26T15:00:00Z"), 30);
  assert.equal(p.taxaFalha.percentual, null);
  assert.equal(p.serie.length, 30);
});

// ── Validação do formulário de limites ───────────────────────────────────────────────

const recusa = (dados: unknown, trecho: RegExp) => assert.throws(() => Validar_Alteracao_Controle(dados), (e: unknown) => e instanceof Erro_Email && e.codigo === "validacao" && trecho.test(e.message));

test("Validar_Alteracao_Controle: aceita inteiros dentro dos tetos e pausa booleana", () => {
  assert.deepEqual(Validar_Alteracao_Controle({ limiteDiario: 0, limiteMensal: 0, percentualAlerta: 80, pausado: false }), { limiteDiario: 0, limiteMensal: 0, percentualAlerta: 80, pausado: false });
  assert.deepEqual(Validar_Alteracao_Controle({ limiteDiario: TETO_LIMITE_DIARIO, limiteMensal: TETO_LIMITE_MENSAL }), { limiteDiario: TETO_LIMITE_DIARIO, limiteMensal: TETO_LIMITE_MENSAL });
  assert.deepEqual(Validar_Alteracao_Controle({ pausado: true }), { pausado: true });
  assert.deepEqual(Validar_Alteracao_Controle({ percentualAlerta: 1 }), { percentualAlerta: 1 });
  assert.deepEqual(Validar_Alteracao_Controle({ percentualAlerta: 100 }), { percentualAlerta: 100 });
});

test("Validar_Alteracao_Controle: recusa negativos, fracionários, texto, acima do teto e campos desconhecidos", () => {
  recusa({ limiteDiario: -1 }, /entre 0 e/);
  recusa({ limiteDiario: 1.5 }, /inteiro/);
  recusa({ limiteDiario: "500" }, /inteiro/);
  recusa({ limiteDiario: null }, /inteiro/);
  recusa({ limiteDiario: NaN }, /inteiro/);
  recusa({ limiteDiario: TETO_LIMITE_DIARIO + 1 }, /entre 0 e/);
  recusa({ limiteMensal: TETO_LIMITE_MENSAL + 1 }, /entre 0 e/);
  recusa({ limiteMensal: -5 }, /entre 0 e/);
  recusa({ percentualAlerta: 0 }, /entre 1 e 100/);
  recusa({ percentualAlerta: 101 }, /entre 1 e 100/);
  recusa({ pausado: "true" }, /verdadeiro ou falso/);
  recusa({ pausado: 1 }, /verdadeiro ou falso/);
  recusa({ limiteDiario: 1, admin: true }, /Campo desconhecido: "admin"/);
  recusa({}, /ao menos um campo/);
  recusa(null, /objeto JSON/);
  recusa([1], /objeto JSON/);
});

// ── Servico_Controle: persistência, auditoria e coerência ────────────────────────────

/** Banco que guarda _Core_Email_Configuracao e o histórico em memória. */
class Banco_Controle extends Banco_Falso {
  public config = new Map<string, { valor: string; por: number | null; em: string }>();
  public historico: Array<Record<string, unknown>> = [];
  public falharHistorico = false;

  public override async Executar(sql: string, valores: unknown[] = []): Promise<any> {
    this.chamadas.push({ sql, valores });
    if (/INSERT INTO _Core_Email_Configuracao_Historico/.test(sql)) {
      if (this.falharHistorico) throw new Error("auditoria fora");
      this.historico.push({ chave: valores[0], antes: valores[1], depois: valores[2], por: valores[3], em: valores[4] });
    } else if (/INSERT INTO _Core_Email_Configuracao /.test(sql)) {
      this.config.set(String(valores[0]), { valor: String(valores[1]), por: valores[2] as number, em: String(valores[3]) });
    }
    return { insertId: 1, affectedRows: 1 };
  }

  public override async Query(sql: string, valores: unknown[] = []): Promise<any[]> {
    this.chamadas.push({ sql, valores });
    if (/FROM _Core_Email_Configuracao$/.test(sql)) return [...this.config].map(([chave, v]) => ({ chave, valor: v.valor, alterado_por: v.por, alterado_em: v.em }));
    if (/FROM _Core_Email_Configuracao_Historico/.test(sql)) return this.historico.map((h, i) => ({ id: i + 1, chave: h.chave, valor_antes: h.antes, valor_depois: h.depois, alterado_por: h.por, alterado_em: h.em }));
    return super.Query(sql, valores);
  }
}

test("Servico_Controle.Obter: sem registros usa o padrão (sem limite, alerta 80%, sem pausa)", async () => {
  const s = new Servico_Controle(new Banco_Controle(), relogioEm("2026-11-26T15:00:00Z"));
  assert.deepEqual(await s.Obter(), { limiteDiario: 0, limiteMensal: 0, percentualAlerta: 80, pausado: false, alteradoPor: null, alteradoEm: null });
});

test("Servico_Controle.Obter: valor corrompido no banco volta ao padrão (nunca vira limite absurdo ou NaN)", async () => {
  const bd = new Banco_Controle();
  bd.config.set("limite_diario", { valor: "abc", por: 1, em: "2026-11-26 08:00:00.000" });
  bd.config.set("limite_mensal", { valor: "-5", por: 1, em: "2026-11-26 08:00:00.000" });
  bd.config.set("percentual_alerta", { valor: "500", por: 1, em: "2026-11-26 08:00:00.000" });
  const c = await new Servico_Controle(bd, new Relogio()).Obter();
  assert.deepEqual([c.limiteDiario, c.limiteMensal, c.percentualAlerta, c.pausado], [0, 0, 80, false]);
});

test("Servico_Controle.Alterar: grava valor + auditoria (quem, quando, antes/depois) e devolve o novo estado", async () => {
  const bd = new Banco_Controle();
  const s = new Servico_Controle(bd, relogioEm("2026-11-26T11:51:21.379Z"));
  const r = await s.Alterar(7, { limiteDiario: 500, limiteMensal: 8000, percentualAlerta: 90, pausado: true });
  assert.deepEqual(r.alterados.sort(), ["limite_diario", "limite_mensal", "pausado", "percentual_alerta"]);
  assert.deepEqual(r.controle, { limiteDiario: 500, limiteMensal: 8000, percentualAlerta: 90, pausado: true, alteradoPor: 7, alteradoEm: "2026-11-26 08:51:21.379" });
  assert.deepEqual(bd.historico.find((h) => h.chave === "limite_diario"), { chave: "limite_diario", antes: "0", depois: "500", por: 7, em: "2026-11-26 08:51:21.379" });
  assert.deepEqual(bd.historico.find((h) => h.chave === "pausado"), { chave: "pausado", antes: "0", depois: "1", por: 7, em: "2026-11-26 08:51:21.379" });
  assert.equal(bd.historico.length, 4);
  // histórico para a tela
  assert.equal((await s.Historico(10)).length, 4);
});

test("Servico_Controle.Alterar: valor igual ao atual não gera registro; só o que mudou", async () => {
  const bd = new Banco_Controle();
  const s = new Servico_Controle(bd, new Relogio());
  await s.Alterar(1, { limiteDiario: 100 });
  const r = await s.Alterar(2, { limiteDiario: 100, limiteMensal: 2000 });
  assert.deepEqual(r.alterados, ["limite_mensal"]);
  assert.equal(bd.historico.length, 2);
  assert.equal((await s.Alterar(3, { limiteDiario: 100 })).alterados.length, 0);
});

test("Servico_Controle.Alterar: auditoria primeiro — se ela falhar, o valor NÃO muda", async () => {
  const bd = new Banco_Controle();
  bd.falharHistorico = true;
  const s = new Servico_Controle(bd, new Relogio());
  await assert.rejects(s.Alterar(1, { limiteDiario: 100 }));
  assert.equal(bd.config.size, 0);
});

test("Servico_Controle.Alterar: diário maior que o mensal é recusado (considerando o valor já gravado)", async () => {
  const bd = new Banco_Controle();
  const s = new Servico_Controle(bd, new Relogio());
  await assert.rejects(s.Alterar(1, { limiteDiario: 500, limiteMensal: 100 }), /diário não pode ser maior/);
  await s.Alterar(1, { limiteDiario: 100, limiteMensal: 1000 });
  await assert.rejects(s.Alterar(1, { limiteMensal: 50 }), /diário não pode ser maior/);
  await s.Alterar(1, { limiteMensal: 0 }); // 0 = sem limite: sempre coerente
  assert.equal((await s.Obter()).limiteMensal, 0);
  assert.equal(bd.historico.length, 3);
});

test("Servico_Controle.Alterar: entrada inválida é recusada sem tocar no banco", async () => {
  const bd = new Banco_Controle();
  await assert.rejects(new Servico_Controle(bd, new Relogio()).Alterar(1, { limiteDiario: -3 }), (e: unknown) => e instanceof Erro_Email && e.codigo === "validacao");
  assert.equal(bd.chamadas.length, 0);
});

// ── Aplicação no envio (pausa, diário, mensal) ───────────────────────────────────────

function montarEnvio(controle: Record<string, string>, consumo: { hoje: number; mes: number; hora?: number }) {
  const config = Config_Teste();
  const bd = new Banco_Falso();
  bd.respostas.push(
    { padrao: /FROM _Core_Email_Configuracao$/, linhas: Object.entries(controle).map(([chave, valor]) => ({ chave, valor, alterado_por: 1, alterado_em: "2026-11-26 08:00:00.000" })) },
    { padrao: /SUM\(CASE WHEN criado_em/, linhas: [{ hora: consumo.hora ?? 0, hoje: consumo.hoje, mes: consumo.mes }] },
  );
  const transporte = new Transporte_Simulado();
  const relogio = relogioEm("2026-11-26T15:00:00Z");
  const servico = new Config_Email(config, bd, transporte, new Templates_Email(NaRaiz(config.Email.PastaTemplates)),
    new Limitador_Taxa(60_000, 1000, 1000), new Servico_Controle(bd, relogio), relogio);
  return { servico, bd, transporte };
}
const sol = { modulo: "WSMod_FibraMap", usuarioId: null };
const pedidoUm = { para: "ana@x.com", assunto: "A", texto: "t" };
const bloqueado = (p: Promise<unknown>, codigo: string, trecho: RegExp) => assert.rejects(p, (e: unknown) => e instanceof Erro_Email && e.codigo === codigo && trecho.test(e.message));

test("envio: sem limite configurado (padrão) e sem pausa envia sem sequer consultar o consumo", async () => {
  const { servico, transporte, bd } = montarEnvio({}, { hoje: 99999, mes: 99999 });
  await servico.Enviar(sol, pedidoUm);
  assert.equal(transporte.Enviadas.length, 1);
  assert.equal(bd.chamadas.filter((c) => /SUM\(CASE/.test(c.sql)).length, 0);
});

test("envio: pausado bloqueia com código 'pausado' — nada enviado, nada registrado", async () => {
  const { servico, transporte, bd } = montarEnvio({ pausado: "1" }, { hoje: 0, mes: 0 });
  await bloqueado(servico.Enviar(sol, pedidoUm), "pausado", /pausado/);
  assert.equal(transporte.Enviadas.length, 0);
  assert.equal(bd.inserts.length, 0);
});

test("envio: limite diário — abaixo envia; o pedido que ultrapassaria é bloqueado inteiro (conta destinatários)", async () => {
  const ok = montarEnvio({ limite_diario: "10" }, { hoje: 9, mes: 9 });
  await ok.servico.Enviar(sol, pedidoUm); // 9 + 1 = 10 (cabe exatamente)
  assert.equal(ok.transporte.Enviadas.length, 1);

  const cheio = montarEnvio({ limite_diario: "10" }, { hoje: 10, mes: 10 });
  await bloqueado(cheio.servico.Enviar(sol, pedidoUm), "limite_diario", /Limite diário.*10 de 10.*meia-noite/);
  assert.equal(cheio.transporte.Enviadas.length, 0);
  assert.equal(cheio.bd.inserts.length, 0);

  const dois = montarEnvio({ limite_diario: "10" }, { hoje: 9, mes: 9 });
  await bloqueado(dois.servico.Enviar(sol, { ...pedidoUm, para: ["a@x.com", "b@x.com"] }), "limite_diario", /este pedido tem 2/);
  assert.equal(dois.transporte.Enviadas.length, 0);
});

test("envio: limite mensal bloqueia com código 'limite_mensal'; o diário é conferido primeiro", async () => {
  const m = montarEnvio({ limite_mensal: "100" }, { hoje: 5, mes: 100 });
  await bloqueado(m.servico.Enviar(sol, pedidoUm), "limite_mensal", /Limite mensal.*100 de 100.*dia 1º/);
  const os2 = montarEnvio({ limite_diario: "5", limite_mensal: "100" }, { hoje: 5, mes: 100 });
  await bloqueado(os2.servico.Enviar(sol, pedidoUm), "limite_diario", /diário/);
});

test("envio: limite 0 = sem limite, mesmo com consumo alto; o outro limite continua valendo", async () => {
  const a = montarEnvio({ limite_diario: "0", limite_mensal: "100" }, { hoje: 5000, mes: 50 });
  await a.servico.Enviar(sol, pedidoUm);
  assert.equal(a.transporte.Enviadas.length, 1);
  const b = montarEnvio({ limite_diario: "0", limite_mensal: "100" }, { hoje: 5000, mes: 100 });
  await bloqueado(b.servico.Enviar(sol, pedidoUm), "limite_mensal", /mensal/);
});

test("envio: falha na leitura do controle NÃO envia (fail-closed) e devolve erro interno", async () => {
  const config = Config_Teste();
  const bd = new Banco_Falso();
  bd.Query = async () => { throw new Error("banco fora"); };
  const transporte = new Transporte_Simulado();
  const relogio = new Relogio();
  const servico = new Config_Email(config, bd, transporte, new Templates_Email(NaRaiz(config.Email.PastaTemplates)), new Limitador_Taxa(60_000, 10, 10), new Servico_Controle(bd, relogio), relogio);
  await assert.rejects(servico.Enviar(sol, pedidoUm), (e: unknown) => e instanceof Erro_Email && e.codigo === "interno" && /não foi enviado/.test(e.message));
  assert.equal(transporte.Enviadas.length, 0);
});

test("envio: dois pedidos simultâneos não passam juntos pelo mesmo saldo", async () => {
  // Saldo de 1 destinatário. O INSERT 'enviando' do primeiro entra na contagem do segundo (reserva).
  const config = Config_Teste();
  const bd = new Banco_Falso();
  let reservado = 0;
  bd.respostas.push({ padrao: /FROM _Core_Email_Configuracao$/, linhas: [{ chave: "limite_diario", valor: "1", alterado_por: 1, alterado_em: "2026-11-26 08:00:00.000" }] });
  const consultaOriginal = bd.Query.bind(bd);
  bd.Query = async (sql: string, valores: unknown[] = []) => /SUM\(CASE/.test(sql) ? [{ hora: reservado, hoje: reservado, mes: reservado }] : consultaOriginal(sql, valores);
  const executarOriginal = bd.Executar.bind(bd);
  bd.Executar = async (sql: string, valores: unknown[] = []) => { await new Promise((r) => setTimeout(r, 5)); if (/^\s*INSERT INTO _Core_Email_Envios/.test(sql)) reservado += 1; return executarOriginal(sql, valores); };
  const transporte = new Transporte_Simulado();
  const relogio = new Relogio();
  const servico = new Config_Email(config, bd, transporte, new Templates_Email(NaRaiz(config.Email.PastaTemplates)), new Limitador_Taxa(60_000, 10, 10), new Servico_Controle(bd, relogio), relogio);
  const resultados = await Promise.allSettled([servico.Enviar(sol, pedidoUm), servico.Enviar(sol, pedidoUm), servico.Enviar(sol, pedidoUm)]);
  assert.equal(resultados.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(resultados.filter((r) => r.status === "rejected" && (r.reason as Erro_Email).codigo === "limite_diario").length, 2);
  assert.equal(transporte.Enviadas.length, 1);
});
