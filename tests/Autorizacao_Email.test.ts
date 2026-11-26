/**
 * Autorização (módulo de origem + permissão opcional do usuário) e rate limit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import "./Helpers";
import { Config_Teste } from "./Helpers";
import { Autorizacao_Email, Resolvedor_Modulos, Resolvedor_Modulos_Core } from "../Server/Controllers/Email/Autorizacao_Email";
import { Limitador_Taxa } from "../Server/Controllers/Email/Limitador_Taxa";
import { Erro_Email } from "../Server/Models/Email/Tipos";

const modulos: Record<string, string> = { "id-fibramap": "WSMod_FibraMap", "id-web": "WSCore_WebServer", "id-outro": "WSMod_GEM" };
const resolvedor: Resolvedor_Modulos = { NomeDoModulo: async (id) => modulos[id] };

function recusado(p: Promise<unknown>, trecho: RegExp) {
  return assert.rejects(p, (e: unknown) => e instanceof Erro_Email && e.codigo === "nao_autorizado" && trecho.test(e.message));
}

test("módulo da lista é autorizado", async () => {
  const a = new Autorizacao_Email(Config_Teste().Autorizacao, resolvedor);
  assert.deepEqual(await a.Autorizar({ origem: "id-fibramap" }), { modulo: "WSMod_FibraMap", usuarioId: null });
});

test("WebServer (navegador do usuário) e módulos fora da lista são recusados", async () => {
  const a = new Autorizacao_Email(Config_Teste().Autorizacao, resolvedor);
  await recusado(a.Autorizar({ origem: "id-web", token: "token-de-usuario-valido" }), /não autorizado/);
  await recusado(a.Autorizar({ origem: "id-outro" }), /não autorizado/);
});

test("origem ausente, vazia, desconhecida ou forjada é recusada", async () => {
  const a = new Autorizacao_Email(Config_Teste().Autorizacao, resolvedor);
  await recusado(a.Autorizar({}), /não identificado/);
  await recusado(a.Autorizar({ origem: "" }), /não identificado/);
  await recusado(a.Autorizar({ origem: 123 }), /não identificado/);
  await recusado(a.Autorizar({ origem: "x".repeat(101) }), /não identificado/);
  await recusado(a.Autorizar({ origem: "id-inexistente" }), /não autorizado/);
  // o nome do módulo não vale como origem: só o ID que o Core atribuiu
  await recusado(a.Autorizar({ origem: "WSMod_FibraMap" }), /não autorizado/);
});

test("lista de módulos permitidos vazia não autoriza ninguém (fail-closed)", async () => {
  const a = new Autorizacao_Email(Config_Teste({ Autorizacao: { ModulosPermitidos: [] } }).Autorizacao, resolvedor);
  await recusado(a.Autorizar({ origem: "id-fibramap" }), /não autorizado/);
});

test("Core indisponível ao resolver a origem recusa o pedido", async () => {
  const a = new Autorizacao_Email(Config_Teste().Autorizacao, { NomeDoModulo: async () => { throw new Error("Core fora"); } });
  await recusado(a.Autorizar({ origem: "id-fibramap" }), /Core indisponível/);
});

test("ExigirPermissaoUsuario: exige token com a permissão email.enviar", async () => {
  const chamadas: Array<[string, string]> = [];
  const autenticador = {
    Autorizar: async (token: string, permissao: string) => {
      chamadas.push([token, permissao]);
      if (token === "bom") return { usuarioId: 42 };
      throw new Error(token === "indisponivel" ? "Autenticador indisponível no momento" : "Sem permissão");
    },
  };
  const a = new Autorizacao_Email(Config_Teste({ Autorizacao: { ExigirPermissaoUsuario: true } }).Autorizacao, resolvedor, autenticador);
  assert.deepEqual(await a.Autorizar({ origem: "id-fibramap", token: "bom" }), { modulo: "WSMod_FibraMap", usuarioId: 42 });
  assert.deepEqual(chamadas[0], ["bom", "email.enviar"]);
  await recusado(a.Autorizar({ origem: "id-fibramap", token: "ruim" }), /sem permissão|sessão inválida/i);
  await recusado(a.Autorizar({ origem: "id-fibramap" }), /sem permissão|sessão inválida/i);
  await recusado(a.Autorizar({ origem: "id-fibramap", token: "indisponivel" }), /Autenticador indisponível/);
  // módulo fora da lista continua recusado mesmo com token bom
  await recusado(a.Autorizar({ origem: "id-web", token: "bom" }), /não autorizado/);
});

test("ExigirPermissaoUsuario sem autenticador configurado recusa", async () => {
  const a = new Autorizacao_Email(Config_Teste({ Autorizacao: { ExigirPermissaoUsuario: true } }).Autorizacao, resolvedor);
  await recusado(a.Autorizar({ origem: "id-fibramap", token: "bom" }), /indisponível/);
});

test("Resolvedor_Modulos_Core: cache, atualização em ID desconhecido e limite de consultas", async () => {
  let consultas = 0;
  let lista = [{ Modulo_ID: "a", Modulo_Nome: "Mod_A" }];
  let agora = 1_000_000;
  const r = new Resolvedor_Modulos_Core({ ListarModulos: async () => { consultas++; return lista; } }, 15_000, 2_000, () => agora);

  assert.equal(await r.NomeDoModulo("a"), "Mod_A");
  assert.equal(await r.NomeDoModulo("a"), "Mod_A");
  assert.equal(consultas, 1, "segunda consulta vem do cache");

  // módulo novo registrado depois: ID desconhecido dentro do intervalo mínimo NÃO consulta o Core
  lista = [...lista, { Modulo_ID: "b", Modulo_Nome: "Mod_B" }];
  assert.equal(await r.NomeDoModulo("b"), undefined);
  assert.equal(consultas, 1);
  // passado o intervalo mínimo, atualiza e encontra
  agora += 2_500;
  assert.equal(await r.NomeDoModulo("b"), "Mod_B");
  assert.equal(consultas, 2);

  // IDs inventados em sequência não geram uma consulta por pacote
  for (let i = 0; i < 20; i++) assert.equal(await r.NomeDoModulo("fake" + i), undefined);
  assert.equal(consultas, 2);

  // cache vencido: reconsulta
  agora += 20_000;
  assert.equal(await r.NomeDoModulo("a"), "Mod_A");
  assert.equal(consultas, 3);
});

test("Limitador_Taxa: limite por módulo, limite global e janela deslizante", () => {
  let agora = 0;
  const l = new Limitador_Taxa(60_000, 3, 5, () => agora);
  const limite = (e: unknown) => e instanceof Erro_Email && e.codigo === "limite_excedido";

  for (let i = 0; i < 3; i++) l.Consumir("A");
  assert.throws(() => l.Consumir("A"), (e) => limite(e) && /este módulo/.test((e as Error).message));
  // outro módulo não é afetado pelo limite do A
  l.Consumir("B"); l.Consumir("B");
  // global = 5 já consumido (3 + 2)
  assert.throws(() => l.Consumir("C"), (e) => limite(e) && /global/.test((e as Error).message));

  // passada a janela, libera de novo
  agora += 60_001;
  l.Consumir("A");
  l.Consumir("C");
});

test("Limitador_Taxa: pedido recusado não consome cota", () => {
  let agora = 0;
  const l = new Limitador_Taxa(1000, 1, 100, () => agora);
  l.Consumir("A");
  for (let i = 0; i < 10; i++) assert.throws(() => l.Consumir("A"));
  agora += 1001;
  l.Consumir("A"); // se as recusas tivessem consumido cota, isto ainda falharia
});
