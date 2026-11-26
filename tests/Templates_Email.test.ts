/**
 * Templates em arquivos e formatação (escape de HTML, variáveis, texto a partir de HTML).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import "./Helpers";
import { NaRaiz } from "../Server/Controllers/Lib/Configuracao";
import { Templates_Email } from "../Server/Controllers/Email/Templates_Email";
import { Escapar_Html, Html_Para_Texto, Substituir_Variaveis, Variaveis_Usadas } from "../Server/Controllers/Email/Formatacao_Email";
import { Erro_Email } from "../Server/Models/Email/Tipos";

const oficiais = new Templates_Email(NaRaiz("./Server/Templates"));

function pastaTemporaria(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wscore-email-tpl-"));
}

test("os templates que acompanham o módulo existem e renderizam", () => {
  assert.deepEqual(oficiais.Listar(), ["generico", "pre_viabilidade_aprovacao"]);
  const r = oficiais.Renderizar("pre_viabilidade_aprovacao", {
    codigo: "PV-123", nome_destinatario: "Ana", solicitante: "Bruno", cliente: "ACME", endereco: "Rua A, 1", link_aprovacao: "https://turbo.exemplo/aprovar/1",
  }, 200);
  assert.equal(r.assunto, "Pré-Viabilidade PV-123 aguardando sua aprovação");
  assert.match(r.texto!, /Olá, Ana!/);
  assert.match(r.html!, /href="https:\/\/turbo\.exemplo\/aprovar\/1"/);
  assert.doesNotMatch(r.html! + r.texto! + r.assunto, /\{\{/);
});

test("variáveis em HTML são escapadas; em texto e assunto, não", () => {
  const r = oficiais.Renderizar("generico", { titulo: "A & B", mensagem: "<script>alert(1)</script>" }, 200);
  assert.equal(r.assunto, "A & B");
  assert.match(r.texto!, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(r.html!, /<script>/);
  assert.match(r.html!, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(r.html!, /A &amp; B/);
});

test("assunto do template nunca carrega quebra de linha (sem injeção de cabeçalho)", () => {
  const r = oficiais.Renderizar("generico", { titulo: "linha1\r\nBcc: x@y.com", mensagem: "m" }, 200);
  assert.equal(r.assunto, "linha1 Bcc: x@y.com");
  assert.doesNotMatch(r.assunto, /[\r\n]/);
});

test("variável do template não informada recusa o envio listando as que faltam", () => {
  assert.throws(() => oficiais.Renderizar("pre_viabilidade_aprovacao", { codigo: "1" }, 200), (e: unknown) => {
    assert.ok(e instanceof Erro_Email);
    assert.equal(e.codigo, "validacao");
    assert.match(e.message, /cliente, endereco, link_aprovacao, nome_destinatario, solicitante/);
    return true;
  });
});

test("template inexistente ou com nome malicioso", () => {
  assert.throws(() => oficiais.Renderizar("nao_existe", {}, 200), (e: unknown) => e instanceof Erro_Email && e.codigo === "template_invalido" && /Disponíveis: generico/.test(e.message));
  for (const nome of ["../Templates", "..", "a/b", "a\\b", "GENERICO", ""]) {
    assert.throws(() => oficiais.Renderizar(nome, {}, 200), (e: unknown) => e instanceof Erro_Email && e.codigo === "validacao");
  }
});

test("template incompleto e assunto acima do limite", () => {
  const pasta = pastaTemporaria();
  fs.mkdirSync(path.join(pasta, "sem_corpo"));
  fs.writeFileSync(path.join(pasta, "sem_corpo", "assunto.txt"), "Oi");
  fs.mkdirSync(path.join(pasta, "longo"));
  fs.writeFileSync(path.join(pasta, "longo", "assunto.txt"), "{{a}}");
  fs.writeFileSync(path.join(pasta, "longo", "corpo.txt"), "x");
  const t = new Templates_Email(pasta);
  assert.throws(() => t.Renderizar("sem_corpo", {}, 200), (e: unknown) => e instanceof Erro_Email && e.codigo === "template_invalido");
  assert.throws(() => t.Renderizar("longo", { a: "x".repeat(11) }, 10), /excede o máximo de 10/);
  assert.equal(t.Renderizar("longo", { a: "ok" }, 10).assunto, "ok");
  fs.rmSync(pasta, { recursive: true, force: true });
});

test("template só com HTML ganha versão texto gerada", () => {
  const pasta = pastaTemporaria();
  fs.mkdirSync(path.join(pasta, "so_html"));
  fs.writeFileSync(path.join(pasta, "so_html", "assunto.txt"), "Assunto");
  fs.writeFileSync(path.join(pasta, "so_html", "corpo.html"), "<p>Olá, {{nome}}</p><p><a href=\"https://x.com/a\">Abrir</a></p>");
  const r = new Templates_Email(pasta).Renderizar("so_html", { nome: "Ana & Cia" }, 200);
  assert.match(r.html!, /Ana &amp; Cia/);
  assert.equal(r.texto, "Olá, Ana & Cia\nAbrir (https://x.com/a)");
  fs.rmSync(pasta, { recursive: true, force: true });
});

test("pasta de templates inexistente lista vazio", () => {
  assert.deepEqual(new Templates_Email(path.join(os.tmpdir(), "wscore-email-nao-existe-xyz")).Listar(), []);
});

test("Formatacao: escape, variáveis usadas e substituição", () => {
  assert.equal(Escapar_Html(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assert.deepEqual(Variaveis_Usadas("{{a}} {{ b_2 }} {{1x}} {x}"), ["a", "b_2"]);
  assert.equal(Substituir_Variaveis("{{a}}-{{ b }}-{{c}}", { a: "1", b: "<" }, true), "1-&lt;-");
  // variável chamada "constructor"/"__proto__" não puxa propriedades herdadas
  assert.equal(Substituir_Variaveis("{{constructor}}|{{toString}}", {}, false), "|");
  assert.equal(Html_Para_Texto("<style>p{}</style><h1>T</h1><ul><li>um</li><li>dois</li></ul>"), "T\n- um\n- dois");
});
