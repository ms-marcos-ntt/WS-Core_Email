/**
 * Entrega da tela: arquivos servidos pelo `webfiles` (sem traversal) e consistência entre menu (SQL),
 * eventos, permissões e config do módulo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import "./Helpers";
import Modelo_Config_JSON from "../Server/Models/Modelo_Config_JSON.json";
import { NaRaiz, RaizProjeto } from "../Server/Controllers/Lib/Configuracao";
import { Resolver_Arquivo_Web, Socket_WebFiles } from "../Server/Controllers/Modulos/Socket_WebFiles";
import { PERMISSAO_ADMINISTRAR, PERMISSAO_VISUALIZAR } from "../Server/Controllers/Email/Socket_Email_Tela";
import { Config_Teste } from "./Helpers";

const PASTA_WEB = NaRaiz(Modelo_Config_JSON.WebFiles.Pasta_Arquivos_Html);
const SQL_TELA = fs.readFileSync(path.join(RaizProjeto(), "Server", "SQL", "data_Core_Email_Tela.sql"), "utf8");
const JS_TELA = fs.readFileSync(path.join(PASTA_WEB, "js", "Email.js"), "utf8");

test("webfiles: serve js e css da tela", () => {
  assert.ok(Resolver_Arquivo_Web(PASTA_WEB, "js/Email.js"));
  assert.ok(Resolver_Arquivo_Web(PASTA_WEB, "css/Email.css"));
  assert.ok(Resolver_Arquivo_Web(PASTA_WEB, "/js/Email.js"), "barra inicial é aceita");
  assert.ok(Resolver_Arquivo_Web(PASTA_WEB, "js\\Email.js"), "barra invertida é normalizada");
});

test("webfiles: recusa traversal, extensão não permitida, diretório, inexistente e entrada estranha", () => {
  for (const ruim of ["../../package.json", "../../../Server/config/config.cfg", "js/../../../package.json", "..\\..\\package.json", "js/%2e%2e/%2e%2e/package.json", "js", "js/", "", "   ", "js/NaoExiste.js", "js/Email.js\0.css", null, undefined, 42, {}]) {
    assert.equal(Resolver_Arquivo_Web(PASTA_WEB, ruim), null, `deveria recusar ${JSON.stringify(ruim)}`);
  }
  // extensão fora da lista: cria arquivo temporário .ts dentro da pasta de telas e confirma a recusa
  const temporario = path.join(PASTA_WEB, "js", "__teste_extensao.ts");
  fs.writeFileSync(temporario, "x");
  try { assert.equal(Resolver_Arquivo_Web(PASTA_WEB, "js/__teste_extensao.ts"), null); } finally { fs.rmSync(temporario, { force: true }); }
});

test("webfiles: handler do Core responde OK com o arquivo e recusa o resto (com e sem o prefixo modulos/<nome>/)", async () => {
  let handler: ((p: any, cb: (r: any) => void) => unknown) | undefined;
  new Socket_WebFiles(Config_Teste(), { Escutar: (e: string, h: any) => { if (e === "webfiles") handler = h; } } as any).Registrar();
  const pedir = (path: unknown) => new Promise<any>((resolve) => { void handler!({ dados: JSON.stringify({ path }) }, resolve); });
  const ok = await pedir("js/Email.js");
  assert.equal(ok.status, "OK");
  assert.match(ok.arquivo, /WSCore_Email/);
  assert.equal((await pedir("modulos/WSCore_Email/css/Email.css")).status, "OK");
  assert.equal((await pedir("../../package.json")).status, "Erro");
  assert.equal((await pedir("modulos/WSCore_Email/../../package.json")).status, "Erro");
  const semDados = await new Promise<any>((resolve) => { void handler!({ dados: "{quebrado" }, resolve); });
  assert.equal(semDados.status, "Erro");
});

test("menu: _Menus.modulo é EXATAMENTE o nome com que o módulo se registra no Core (senão o Core marca 'módulo desligado')", () => {
  const nome = Modelo_Config_JSON.modulo.nome;
  assert.equal(nome, "WSCore_Email");
  // cada INSERT de _Menus: o 8º valor (modulo) precisa ser o nome do módulo
  const inserts = [...SQL_TELA.matchAll(/INSERT INTO _Menus[\s\S]*?SELECT\s+([\s\S]*?)\s+FROM DUAL/g)];
  assert.equal(inserts.length, 3, "menu pai + 2 telas");
  for (const m of inserts) {
    const valores = [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((v) => v[1]);
    assert.equal(valores[6], nome, `modulo do menu ${valores[0]}`);
  }
  // e o UPDATE de correção cobre os três itens
  assert.match(SQL_TELA, new RegExp(`UPDATE _Menus SET modulo = '${nome}' WHERE codigo IN \\('email', 'email/historico', 'email/uso'\\)`));
});

test("menu: eventos, scripts e permissões do SQL batem com o código e os arquivos", () => {
  const eventos = [...SQL_TELA.matchAll(/'(open\/email\/[a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(eventos.sort(), ["open/email/historico", "open/email/uso"]);
  for (const e of eventos) assert.ok(JS_TELA.includes(`_Eventos.on("${e}"`), `Email.js escuta ${e}`);

  const scripts = [...SQL_TELA.matchAll(/'\.\/modulos\/WSCore_Email\/(js\/[A-Za-z]+\.js)'/g)].map((m) => m[1]);
  assert.equal(scripts.length, 2);
  for (const s of scripts) assert.ok(fs.existsSync(path.join(PASTA_WEB, s)), `existe ${s}`);

  assert.ok(SQL_TELA.includes(`'${PERMISSAO_VISUALIZAR}'`) && SQL_TELA.includes(`'${PERMISSAO_ADMINISTRAR}'`));
  // o menu exige a permissão de visualizar; ninguém vê a tela só com administrar
  const exigidas = [...SQL_TELA.matchAll(/'1', '(email\.[a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(exigidas)], [PERMISSAO_VISUALIZAR]);
  // idempotência: nada de INSERT sem WHERE NOT EXISTS (as tabelas não têm UNIQUE)
  assert.equal((SQL_TELA.match(/INSERT INTO/g) ?? []).length, (SQL_TELA.match(/^WHERE NOT EXISTS/gm) ?? []).length);
});

test("front: o JS fecha a aba (5º argumento), usa o container/holder corretos e escapa texto do servidor", () => {
  assert.match(JS_TELA, /Adicionar_Aba_Superior\(ID_TELA, [^;]*tela\.Abrir_Tela\(\), \(\) => tela\.Fechar_Tela\(\)\)/);
  assert.ok(JS_TELA.includes('className = "wscore_tela_holder hide"'));
  assert.ok(JS_TELA.includes('document.getElementById("wscore_conteudo_principal")'));
  // todo `${...}` dentro de HTML que traga campo do servidor passa por esc/num/nBr/bytes/dh/badge/codigoErro:
  // procura interpolações de propriedades de registro (r./d./e./l./h./c./m./p.) soltas em template strings
  const solto = [...JS_TELA.matchAll(/\$\{\s*([a-z]{1,3}\.[A-Za-z.]+)\s*\}/g)].map((m) => m[1]);
  assert.deepEqual(solto, [], `interpolações sem escape: ${solto.join(", ")}`);
});
