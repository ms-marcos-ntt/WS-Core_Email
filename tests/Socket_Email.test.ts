/**
 * Fluxo completo: Core falso (handshake + core/modulos/listar) -> Socket_Client real ->
 * Socket_Email -> autorização -> envio simulado -> log em banco falso.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import { AddressInfo } from "net";
import { Server, Socket } from "socket.io";
import { Banco_Falso, Config_Teste } from "./Helpers";
import { NaRaiz } from "../Server/Controllers/Lib/Configuracao";
import { Socket_Client } from "../Server/Controllers/Modulos/Socket_Client";
import { Modulos_Struct } from "../Server/Models/Modulos/Modulos_Struct";
import { Autorizacao_Email, Resolvedor_Modulos_Core } from "../Server/Controllers/Email/Autorizacao_Email";
import { Config_Email } from "../Server/Controllers/Email/Config_Email";
import { Limitador_Taxa } from "../Server/Controllers/Email/Limitador_Taxa";
import { Socket_Email } from "../Server/Controllers/Email/Socket_Email";
import { Templates_Email } from "../Server/Controllers/Email/Templates_Email";
import { Transporte_Simulado } from "../Server/Controllers/Email/Transporte_Email";
import { Pacotes_Socket } from "../Server/Models/Modulos/Pacotes_Socket";

interface Core_Falso { porta: number; modulo?: Socket; fechar(): Promise<void> }

const MODULOS_DO_CORE = [
  { Modulo_ID: "id-fibramap", Modulo_Nome: "WSMod_FibraMap" },
  { Modulo_ID: "id-webserver", Modulo_Nome: "WSCore_WebServer" },
];

function CriarCoreFalso(): Promise<Core_Falso> {
  return new Promise((resolve) => {
    const httpServer = http.createServer();
    const io = new Server(httpServer);
    const core: Core_Falso = { porta: 0, fechar: () => new Promise((r) => io.close(() => r())) };
    io.on("connection", (s) => {
      s.once("init/modulos/end_setup", () => { core.modulo = s; s.emit("init/modulos/ack", {}); });
      s.on("core/modulos/listar", (_d: unknown, cb: Function) => cb({ status: "ok", dados: MODULOS_DO_CORE }));
      s.emit("init/modulos/setup", { Modulo_ID: "id-email" });
    });
    httpServer.listen(0, "127.0.0.1", () => { core.porta = (httpServer.address() as AddressInfo).port; resolve(core); });
  });
}

const abertos: Array<{ c: Socket_Client; core: Core_Falso }> = [];
after(async () => { for (const a of abertos) { a.c.Desconectar(); await a.core.fechar(); } });

async function montar(extra: Record<string, unknown> = {}) {
  const core = await CriarCoreFalso();
  const config = Config_Teste(extra);
  const dados = new Modulos_Struct();
  dados.Modulo_Nome = config.modulo.nome;
  const cliente = new Socket_Client({ host: "127.0.0.1", porta: core.porta, timeoutMs: 1000 }, dados);
  abertos.push({ c: cliente, core });

  const bd = new Banco_Falso();
  const transporte = new Transporte_Simulado();
  const servico = new Config_Email(config, bd, transporte, new Templates_Email(NaRaiz(config.Email.PastaTemplates)),
    new Limitador_Taxa(config.RateLimit.JanelaSegundos * 1000, config.RateLimit.MaximoPorModulo, config.RateLimit.MaximoGlobal));
  const autorizacao = new Autorizacao_Email(config.Autorizacao, new Resolvedor_Modulos_Core(cliente));
  new Socket_Email(cliente, servico, autorizacao).Registrar();
  await cliente.Connect();

  /** O Core entrega ao módulo o pacote montado por quem pediu (aqui, com a origem escolhida). */
  const pedir = (evento: string, origem: string, dados: unknown, token = "") =>
    new Promise<any>((resolve) => {
      const pacote: Pacotes_Socket = { evento, destino: "WSCore_Email/*", origem, token, dados: JSON.stringify(dados) };
      core.modulo!.emit(evento, pacote, resolve);
    });
  return { cliente, bd, transporte, pedir };
}

const pedido = { para: "ana@exemplo.com.br", assunto: "Aprovação", texto: "Olá" };

test("ListarModulos devolve os módulos do Core", async () => {
  const { cliente } = await montar();
  assert.deepEqual(await cliente.ListarModulos(), MODULOS_DO_CORE);
});

test("ListarModulos rejeita quando não está registrado", async () => {
  const c = new Socket_Client({ host: "127.0.0.1", porta: 1, timeoutMs: 200 }, new Modulos_Struct());
  await assert.rejects(c.ListarModulos(), /indisponível/);
  c.Desconectar();
});

test("email/enviar: módulo permitido envia e recebe { status: OK, dados }", async () => {
  const { pedir, transporte, bd } = await montar();
  const r = await pedir("email/enviar", "id-fibramap", pedido);
  assert.equal(r.status, "OK");
  assert.equal(r.dados.id, 1);
  assert.equal(r.dados.destinatarios, 1);
  assert.equal(r.dados.transporte, "simulado");
  assert.equal(transporte.Enviadas.length, 1);
  assert.equal(transporte.Enviadas[0].assunto, "Aprovação");
  assert.equal(bd.inserts[0].valores[0], "WSMod_FibraMap");
});

test("email/enviar com template", async () => {
  const { pedir, transporte } = await montar();
  const r = await pedir("email/enviar", "id-fibramap", { para: ["a@x.com"], template: "generico", variaveis: { titulo: "Olá", mensagem: "Corpo" } });
  assert.equal(r.status, "OK");
  assert.equal(transporte.Enviadas[0].assunto, "Olá");
});

test("email/enviar: pedido vindo do WebServer (navegador do usuário) é recusado e nada é enviado", async () => {
  const { pedir, transporte, bd } = await montar();
  const r = await pedir("email/enviar", "id-webserver", pedido, "token-de-usuario");
  assert.equal(r.status, "Erro");
  assert.equal(r.codigo, "nao_autorizado");
  assert.equal(transporte.Enviadas.length, 0);
  assert.equal(bd.inserts.length, 0);
});

test("email/enviar: origem forjada/desconhecida/ausente é recusada", async () => {
  const { pedir, transporte } = await montar();
  for (const origem of ["id-que-nao-existe", "WSMod_FibraMap", ""]) {
    const r = await pedir("email/enviar", origem, pedido);
    assert.equal(r.status, "Erro", `origem ${JSON.stringify(origem)}`);
    assert.equal(r.codigo, "nao_autorizado");
  }
  assert.equal(transporte.Enviadas.length, 0);
});

test("email/enviar: validação devolve codigo 'validacao' com mensagem clara", async () => {
  const { pedir, transporte } = await montar();
  const r = await pedir("email/enviar", "id-fibramap", { ...pedido, para: "ruim" });
  assert.deepEqual([r.status, r.codigo], ["Erro", "validacao"]);
  assert.match(r.mensagem, /E-mail inválido em "para"/);
  assert.equal(transporte.Enviadas.length, 0);
});

test("email/enviar: falha do transporte volta como erro com código, sem texto do servidor", async () => {
  const { pedir, transporte } = await montar();
  transporte.FalharCom = Object.assign(new Error("550 5.7.1 Relay access denied for ana@exemplo.com.br"), { responseCode: 550 });
  const r = await pedir("email/enviar", "id-fibramap", pedido);
  assert.deepEqual([r.status, r.codigo], ["Erro", "smtp_erro"]);
  assert.doesNotMatch(r.mensagem, /Relay access denied|ana@exemplo/);
});

test("email/enviar: erro inesperado vira 'interno' sem vazar detalhes", async () => {
  const { pedir, bd } = await montar();
  bd.falharInsert = true;
  const r = await pedir("email/enviar", "id-fibramap", pedido);
  assert.deepEqual([r.status, r.codigo], ["Erro", "interno"]);
  assert.doesNotMatch(r.mensagem, /ECONNREFUSED|INSERT/);
});

test("email/enviar: rate limit aparece como 'limite_excedido'", async () => {
  const { pedir } = await montar({ RateLimit: { MaximoPorModulo: 1 } });
  assert.equal((await pedir("email/enviar", "id-fibramap", pedido)).status, "OK");
  const r = await pedir("email/enviar", "id-fibramap", pedido);
  assert.deepEqual([r.status, r.codigo], ["Erro", "limite_excedido"]);
});

test("email/templates: só para módulo permitido", async () => {
  const { pedir } = await montar();
  const ok = await pedir("email/templates", "id-fibramap", {});
  assert.deepEqual(ok, { status: "OK", dados: ["generico", "pre_viabilidade_aprovacao"] });
  const negado = await pedir("email/templates", "id-webserver", {});
  assert.equal(negado.codigo, "nao_autorizado");
});

test("email/ping: público, informa transporte/configuração e nada sensível", async () => {
  const { pedir } = await montar();
  const r = await pedir("email/ping", "id-webserver", {});
  assert.deepEqual(r, { status: "OK", dados: { modulo: "WSCore_Email", versao: "0.1.0", transporte: "simulado", configurado: true } });
});
