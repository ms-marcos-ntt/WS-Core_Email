/**
 * Validação rígida do pacote email/enviar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Config_Teste } from "./Helpers";
import { Normalizar_Endereco, Validar_Pedido } from "../Server/Controllers/Email/Validacao_Email";
import { Erro_Email } from "../Server/Models/Email/Tipos";

const L = Config_Teste().Email.Limites;
const base = { para: "pessoa@exemplo.com.br", assunto: "Olá", texto: "corpo" };

function recusa(dados: unknown, trecho: RegExp, limites = L) {
  assert.throws(() => Validar_Pedido(typeof dados === "string" ? dados : JSON.stringify(dados), limites), (e: unknown) => {
    assert.ok(e instanceof Erro_Email, "deveria ser Erro_Email");
    assert.equal(e.codigo, "validacao");
    assert.match(e.message, trecho);
    return true;
  });
}

test("aceita pedido mínimo e normaliza e-mails (minúsculas, trim)", () => {
  const p = Validar_Pedido(JSON.stringify({ ...base, para: "  Pessoa@Exemplo.COM.br " }), L);
  assert.deepEqual(p.para, ["pessoa@exemplo.com.br"]);
  assert.equal(p.assunto, "Olá");
  assert.deepEqual(p.cc, []);
});

test("aceita objeto já parseado e listas em para/cc/bcc", () => {
  const p = Validar_Pedido({ ...base, para: ["a@x.com", "b@x.com"], cc: "c@x.com", bcc: ["d@x.com"] }, L);
  assert.deepEqual([p.para, p.cc, p.bcc], [["a@x.com", "b@x.com"], ["c@x.com"], ["d@x.com"]]);
});

test("remove duplicados entre para/cc/bcc (para tem prioridade)", () => {
  const p = Validar_Pedido({ ...base, para: ["a@x.com", "A@x.com"], cc: ["a@x.com", "b@x.com"], bcc: ["b@x.com", "c@x.com"] }, L);
  assert.deepEqual([p.para, p.cc, p.bcc], [["a@x.com"], ["b@x.com"], ["c@x.com"]]);
});

test("recusa JSON inválido, não-objeto e campo desconhecido", () => {
  recusa("{quebrado", /JSON válido/);
  recusa("[1,2]", /objeto JSON/);
  recusa({ ...base, destinatario: "x@y.com" }, /Campo desconhecido: "destinatario"/);
});

test("exige destinatário", () => {
  recusa({ assunto: "a", texto: "b" }, /obrigatório ausente: para/);
  recusa({ ...base, para: [] }, /obrigatório ausente: para/);
});

test("recusa e-mails malformados e tentativas de injeção de cabeçalho", () => {
  for (const ruim of ["sem-arroba", "a@b", "a@@b.com", "a b@c.com", "Nome <a@b.com>", "a@b.com, c@d.com", "a@b.com\r\nBcc: x@y.com", "a@b.com\nCc: x@y.com", ".a@b.com", "a..b@c.com", "a@-b.com", "<script>@b.com", "a@b.c", `${"x".repeat(65)}@b.com`, `a@${"d".repeat(250)}.com`]) {
    assert.equal(Normalizar_Endereco(ruim), undefined, `deveria recusar: ${JSON.stringify(ruim)}`);
    recusa({ ...base, para: ruim }, /E-mail inválido em "para"/);
  }
  recusa({ ...base, cc: ["ok@x.com", "ruim"] }, /E-mail inválido em "cc" \(posição 2\)/);
  recusa({ ...base, bcc: [123] }, /E-mail inválido em "bcc"/);
  recusa({ ...base, para: { a: 1 } }, /e-mail ou uma lista/);
});

test("a mensagem de erro não repete o endereço recebido", () => {
  assert.throws(() => Validar_Pedido({ ...base, para: "segredo-pessoal@@x.com" }, L), (e: unknown) => !(e as Error).message.includes("segredo-pessoal"));
});

test("limita a quantidade de destinatários (por campo e no total)", () => {
  const muitos = Array.from({ length: L.MaxDestinatarios + 1 }, (_, i) => `u${i}@x.com`);
  recusa({ ...base, para: muitos }, /excede o máximo de 50 destinatários/);
  const metade = Array.from({ length: 30 }, (_, i) => `a${i}@x.com`);
  const outra = Array.from({ length: 30 }, (_, i) => `b${i}@x.com`);
  recusa({ ...base, para: metade, cc: outra }, /Total de destinatários excede/);
});

test("assunto: obrigatório, sem quebra de linha, com limite", () => {
  recusa({ para: base.para, texto: "x" }, /obrigatório ausente: assunto/);
  recusa({ ...base, assunto: "   " }, /obrigatório ausente: assunto/);
  recusa({ ...base, assunto: "linha1\r\nBcc: x@y.com" }, /quebra de linha/);
  recusa({ ...base, assunto: "a".repeat(L.MaxAssunto + 1) }, /excede o máximo de 200/);
  recusa({ ...base, assunto: 42 }, /deve ser texto/);
});

test("corpo: exige texto e/ou html, com limites de tamanho", () => {
  recusa({ para: base.para, assunto: "a" }, /Informe o corpo/);
  recusa({ ...base, texto: "  " }, /Informe o corpo/);
  assert.equal(Validar_Pedido({ para: base.para, assunto: "a", html: "<p>oi</p>" }, L).html, "<p>oi</p>");
  recusa({ ...base, texto: "x".repeat(L.MaxTexto + 1) }, /"texto" excede/);
  recusa({ ...base, html: "x".repeat(L.MaxHtml + 1) }, /"html" excede/);
  recusa({ ...base, texto: "a\u0000b" }, /caracteres inválidos/);
});

test("template: não pode vir junto de assunto/texto/html; variáveis só com template", () => {
  const ok = Validar_Pedido({ para: base.para, template: "generico", variaveis: { titulo: "T", n: 3, b: true } }, L);
  assert.equal(ok.template, "generico");
  assert.deepEqual(ok.variaveis, { titulo: "T", n: "3", b: "true" });
  recusa({ para: base.para, template: "generico", assunto: "x" }, /não envie "assunto"/);
  recusa({ para: base.para, template: "generico", texto: "x" }, /não envie "assunto"/);
  recusa({ ...base, variaveis: { a: "b" } }, /só pode ser usado junto com "template"/);
});

test("template e variáveis: nomes e valores validados", () => {
  recusa({ para: base.para, template: "../etc/passwd" }, /"template" inválido/);
  recusa({ para: base.para, template: "Generico" }, /"template" inválido/);
  recusa({ para: base.para, template: "a/b" }, /"template" inválido/);
  recusa({ para: base.para, template: "generico", variaveis: { "1ruim": "x" } }, /Nome de variável inválido/);
  recusa({ para: base.para, template: "generico", variaveis: { a: { b: 1 } } }, /deve ser texto, número ou booleano/);
  recusa({ para: base.para, template: "generico", variaveis: { a: "x".repeat(5001) } }, /excede o máximo de 5000/);
  recusa({ para: base.para, template: "generico", variaveis: [1, 2] }, /deve ser um objeto/);
});

test("responderPara e referencia", () => {
  const p = Validar_Pedido({ ...base, responderPara: "Resp@X.com", referencia: "fibramap:pre_viabilidade:123" }, L);
  assert.equal(p.responderPara, "resp@x.com");
  assert.equal(p.referencia, "fibramap:pre_viabilidade:123");
  recusa({ ...base, responderPara: "nao-e-email" }, /"responderPara"/);
  recusa({ ...base, referencia: "a\nb" }, /quebra de linha/);
  recusa({ ...base, referencia: "r".repeat(121) }, /excede o máximo de 120/);
});

const pdf = Buffer.from("%PDF-1.4 conteudo").toString("base64");

test("anexos: aceita base64 válido e devolve Buffer", () => {
  const p = Validar_Pedido({ ...base, anexos: [{ nome: "proposta.pdf", conteudoBase64: pdf, tipo: "application/pdf" }] }, L);
  assert.equal(p.anexos.length, 1);
  assert.equal(p.anexos[0].nome, "proposta.pdf");
  assert.equal(p.anexos[0].conteudo.toString(), "%PDF-1.4 conteudo");
  assert.equal(p.anexos[0].tipo, "application/pdf");
});

test("anexos: recusa nome perigoso, extensão bloqueada, base64 inválido e vazio", () => {
  const a = (extra: Record<string, unknown>) => ({ ...base, anexos: [{ nome: "a.pdf", conteudoBase64: pdf, ...extra }] });
  recusa(a({ nome: "../../segredo.pdf" }), /não permitidos/);
  recusa(a({ nome: "a/b.pdf" }), /não permitidos/);
  recusa(a({ nome: "a\r\nb.pdf" }), /não permitidos/);
  recusa(a({ nome: ".htaccess" }), /não permitidos/);
  recusa(a({ nome: "virus.exe" }), /não permitido \(\.exe\)/);
  recusa(a({ nome: "script.PS1" }), /não permitido/);
  recusa(a({ conteudoBase64: "não é base64!!" }), /base64 válido/);
  recusa(a({ conteudoBase64: "" }), /não vazio/);
  recusa(a({ tipo: "texto qualquer" }), /tipo inválido/);
  recusa(a({ extra: 1 }), /campo desconhecido "extra"/);
  recusa({ ...base, anexos: "x" }, /deve ser uma lista/);
  recusa({ ...base, anexos: ["x"] }, /deve ser um objeto/);
});

test("anexos: limites de quantidade, tamanho individual e total", () => {
  const anexo = (n: number) => ({ nome: `a${n}.pdf`, conteudoBase64: pdf });
  recusa({ ...base, anexos: [anexo(1), anexo(2), anexo(3), anexo(4)] }, /excede o máximo de 3 anexos/);
  const limites = { ...L, MaxAnexoBytes: 10, MaxTotalAnexosBytes: 25 };
  const grande = Buffer.alloc(11, 1).toString("base64");
  recusa({ ...base, anexos: [{ nome: "g.pdf", conteudoBase64: grande }] }, /excede o tamanho máximo de 10 bytes/, limites);
  const dez = Buffer.alloc(10, 1).toString("base64");
  recusa({ ...base, anexos: [{ nome: "1.pdf", conteudoBase64: dez }, { nome: "2.pdf", conteudoBase64: dez }, { nome: "3.pdf", conteudoBase64: dez }] }, /tamanho total máximo de 25/, limites);
});
