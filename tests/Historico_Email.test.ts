/**
 * Consulta do histórico: filtros, paginação e ordenação seguras.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Banco_Falso } from "./Helpers";
import { COLUNAS_ORDENAVEIS, Escapar_Like, Historico_Email, LIMITE_MAXIMO, Montar_Consulta, Validar_Filtros } from "../Server/Controllers/Email/Historico_Email";
import { Erro_Email } from "../Server/Models/Email/Tipos";

const invalido = (dados: unknown, trecho: RegExp) => assert.throws(() => Validar_Filtros(dados), (e: unknown) => e instanceof Erro_Email && e.codigo === "validacao" && trecho.test(e.message));

test("Validar_Filtros: padrões (página 1, 50 por página, mais recentes primeiro)", () => {
  assert.deepEqual(Validar_Filtros({}), { busca: undefined, status: undefined, modulo: undefined, de: undefined, ate: undefined, pagina: 1, limite: 50, ordem: "criadoEm", direcao: "desc" });
  assert.equal(Validar_Filtros(null).pagina, 1);
});

test("Validar_Filtros: aceita filtros válidos e normaliza", () => {
  const f = Validar_Filtros({ busca: "  aprovação ", status: "falhou", modulo: "WSMod_FibraMap", de: "2026-11-01", ate: "2026-11-30", pagina: 3, limite: 25, ordem: "assunto", direcao: "ASC" });
  assert.deepEqual([f.busca, f.status, f.modulo, f.de, f.ate, f.pagina, f.limite, f.ordem, f.direcao], ["aprovação", "falhou", "WSMod_FibraMap", "2026-11-01", "2026-11-30", 3, 25, "assunto", "asc"]);
  assert.equal(Validar_Filtros({ pagina: "2", limite: "10" }).limite, 10, "números em texto (querystring) também valem");
});

test("Validar_Filtros: limite e página são contidos nos tetos; negativos e lixo viram o mínimo/erro", () => {
  assert.equal(Validar_Filtros({ limite: 100000 }).limite, LIMITE_MAXIMO);
  assert.equal(Validar_Filtros({ limite: 0 }).limite, 1);
  assert.equal(Validar_Filtros({ limite: -5 }).limite, 1);
  assert.equal(Validar_Filtros({ pagina: 0 }).pagina, 1);
  assert.equal(Validar_Filtros({ pagina: 99999999 }).pagina, 100000);
  invalido({ pagina: 1.5 }, /inteiro/);
  invalido({ limite: "abc" }, /inteiro/);
  invalido({ pagina: {} }, /inteiro/);
});

test("Validar_Filtros: status, datas e textos inválidos são recusados", () => {
  invalido({ status: "excluido" }, /Status inválido/);
  invalido({ status: "falhou' OR '1'='1" }, /Status inválido/);
  invalido({ de: "2026-02-30" }, /Data inicial inválida/);
  invalido({ ate: "ontem" }, /Data final inválida/);
  invalido({ de: "2026-11-30", ate: "2026-11-01" }, /não pode ser depois/);
  invalido({ busca: "x".repeat(101) }, /excede 100/);
  invalido({ modulo: "m".repeat(101) }, /excede 100/);
  invalido({ busca: "a\u0000b" }, /caracteres inválidos/);
  invalido({ busca: 123 }, /inválido/);
  invalido([1, 2], /objeto JSON/);
});

test("Validar_Filtros: coluna de ordenação fora da lista cai no padrão (nunca vai para o SQL)", () => {
  for (const ruim of ["id; DROP TABLE _Core_Email_Envios", "criado_em", "para DESC, (SELECT SLEEP(5))", "__proto__", "constructor", "toString", "", 5, null]) {
    assert.equal(Validar_Filtros({ ordem: ruim }).ordem, "criadoEm", `ordem ${JSON.stringify(ruim)}`);
  }
  for (const chave of Object.keys(COLUNAS_ORDENAVEIS)) assert.equal(Validar_Filtros({ ordem: chave }).ordem, chave);
  assert.equal(Validar_Filtros({ direcao: "asc; DROP" }).direcao, "desc");
  assert.equal(Validar_Filtros({ direcao: "ASC" }).direcao, "asc");
});

test("Montar_Consulta: sem filtros — ordenação fixa, paginação por parâmetro", () => {
  const c = Montar_Consulta(Validar_Filtros({ pagina: 3, limite: 20 }));
  assert.match(c.sql, /FROM _Core_Email_Envios ORDER BY criado_em DESC, id DESC LIMIT \? OFFSET \?$/);
  assert.deepEqual(c.params, [20, 40]);
  assert.doesNotMatch(c.sql, / WHERE /);
  assert.equal(c.sqlTotal, "SELECT COUNT(*) AS total FROM _Core_Email_Envios");
  assert.deepEqual(c.paramsTotal, []);
  assert.doesNotMatch(c.sql, /\bcc\b|bcc|erro,|message_id/, "a lista não traz cc/bcc/erro completos (só o detalhe)");
});

test("Montar_Consulta: filtros viram condições com parâmetros; o mesmo WHERE vale para o total", () => {
  const c = Montar_Consulta(Validar_Filtros({ busca: "ana", status: "enviado", modulo: "WSMod_FibraMap", de: "2026-11-01", ate: "2026-11-30", ordem: "tamanho", direcao: "asc" }));
  assert.match(c.sql, /WHERE \(solicitante_modulo LIKE \? OR referencia LIKE \? OR para LIKE \? OR cc LIKE \? OR bcc LIKE \? OR assunto LIKE \? OR template LIKE \? OR erro_codigo LIKE \? OR message_id LIKE \?\) AND status = \? AND solicitante_modulo = \? AND criado_em >= \? AND criado_em < \? ORDER BY tamanho_bytes ASC, id DESC LIMIT \? OFFSET \?/);
  assert.deepEqual(c.params, [...Array(9).fill("%ana%"), "enviado", "WSMod_FibraMap", "2026-11-01 00:00:00.000", "2026-12-01 00:00:00.000", 50, 0]);
  assert.match(c.sqlTotal, /^SELECT COUNT\(\*\) AS total FROM _Core_Email_Envios WHERE .* AND criado_em < \?$/);
  assert.equal(c.paramsTotal.length, c.params.length - 2);
  // "até" é inclusivo: a consulta vai até a meia-noite do dia seguinte (exclusive)
});

test("Montar_Consulta: texto digitado NUNCA entra no SQL (injeção e curingas)", () => {
  const ataque = "'; DROP TABLE _Core_Email_Envios; --";
  const c = Montar_Consulta(Validar_Filtros({ busca: ataque, modulo: ataque }));
  assert.ok(!c.sql.includes("DROP") && !c.sqlTotal.includes("DROP"));
  assert.ok(c.params.includes(`%${Escapar_Like(ataque)}%`) && c.params.includes(ataque));
  // % e _ digitados valem como texto, não como curinga
  assert.equal(Escapar_Like("100%_ok\\"), "100\\%\\_ok\\\\");
  assert.ok(Montar_Consulta(Validar_Filtros({ busca: "50%" })).params.includes("%50\\%%"));
});

test("Historico_Email.Listar: executa página e total com os mesmos filtros e mapeia os campos", async () => {
  const bd = new Banco_Falso();
  bd.respostas.push(
    { padrao: /COUNT\(\*\)/, linhas: [{ total: "123" }] },
    { padrao: /ORDER BY/, linhas: [{ id: 5, criado_em: "2026-11-26 08:51:21.379", solicitante_modulo: "WSMod_FibraMap", referencia: "fibramap:pv:1", para: "ana@x.com", qtd_destinatarios: 1, assunto: "Olá", template: null, qtd_anexos: 0, tamanho_bytes: 120, status: "enviado", erro_codigo: null }] },
  );
  const r = await new Historico_Email(bd).Listar({ status: "enviado", pagina: 2, limite: 10 });
  assert.equal(r.total, 123);
  assert.deepEqual(r.items[0], { id: 5, criadoEm: "2026-11-26 08:51:21.379", modulo: "WSMod_FibraMap", referencia: "fibramap:pv:1", para: "ana@x.com", qtdDestinatarios: 1, assunto: "Olá", template: null, anexos: 0, tamanho: 120, status: "enviado", erroCodigo: null });
  const lista = bd.chamadas.find((c) => /ORDER BY/.test(c.sql))!;
  assert.deepEqual(lista.valores, ["enviado", 10, 10]);
});

test("Historico_Email.Listar: filtro inválido não chega ao banco", async () => {
  const bd = new Banco_Falso();
  await assert.rejects(new Historico_Email(bd).Listar({ status: "x" }), (e: unknown) => e instanceof Erro_Email);
  assert.equal(bd.chamadas.length, 0);
});

test("Historico_Email.Obter: id validado, detalhe completo e 'não encontrado'", async () => {
  const bd = new Banco_Falso();
  const h = new Historico_Email(bd);
  for (const ruim of [undefined, 0, -1, 1.5, "1; DROP", "abc", null, {}]) {
    await assert.rejects(h.Obter({ id: ruim }), (e: unknown) => e instanceof Erro_Email && /"id" inválido/.test(e.message), `id ${JSON.stringify(ruim)}`);
  }
  await assert.rejects(h.Obter(null), (e: unknown) => e instanceof Erro_Email);
  assert.equal(bd.chamadas.length, 0);

  bd.respostas.push({ padrao: /WHERE id = \?/, linhas: [] });
  await assert.rejects(h.Obter({ id: 9 }), /não encontrado/);
  bd.respostas.length = 0;
  bd.respostas.push({ padrao: /WHERE id = \?/, linhas: [{ id: 9, criado_em: "2026-11-26 08:00:00.000", concluido_em: "2026-11-26 08:00:01.000", solicitante_modulo: "WSMod_FibraMap", usuario_id: null, referencia: null, para: "a@x.com, b@x.com", cc: null, bcc: "c@x.com", assunto: "S", template: "generico", qtd_anexos: 1, tamanho_bytes: 10, qtd_destinatarios: 3, qtd_aceitos: 2, transporte: "smtp", status: "enviado", message_id: "<m@ses>", erro_codigo: null, erro: null }] });
  const d = await h.Obter({ id: "9" });
  assert.deepEqual([d.id, d.para, d.cc, d.bcc, d.qtdDestinatarios, d.qtdAceitos, d.messageId, d.concluidoEm], [9, "a@x.com, b@x.com", null, "c@x.com", 3, 2, "<m@ses>", "2026-11-26 08:00:01.000"]);
  assert.deepEqual(bd.chamadas.at(-1)!.valores, [9]);
});

test("Historico_Email.Opcoes: módulos distintos e status", async () => {
  const bd = new Banco_Falso();
  bd.respostas.push({ padrao: /DISTINCT/, linhas: [{ m: "WSMod_FibraMap" }, { m: "WSMod_GEM" }] });
  assert.deepEqual(await new Historico_Email(bd).Opcoes(), { modulos: ["WSMod_FibraMap", "WSMod_GEM"], status: ["enviado", "falhou", "enviando"] });
});
