/**
 * Serviço de envio: validação + template + rate limit + log em banco + transporte simulado.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Banco_Falso, Config_Teste } from "./Helpers";
import { NaRaiz } from "../Server/Controllers/Lib/Configuracao";
import { Config_Email } from "../Server/Controllers/Email/Config_Email";
import { Limitador_Taxa } from "../Server/Controllers/Email/Limitador_Taxa";
import { Templates_Email } from "../Server/Controllers/Email/Templates_Email";
import { Transporte_Email, Transporte_SMTP, Transporte_Simulado } from "../Server/Controllers/Email/Transporte_Email";
import { Erro_Email } from "../Server/Models/Email/Tipos";
import { Modelo_Configuracao } from "../Server/Models/Modelo_Configuracao";

const solicitante = { modulo: "WSMod_FibraMap", usuarioId: null };
const pedido = { para: "ana@exemplo.com.br", assunto: "Teste", texto: "Olá" };

function montar(extra: Record<string, unknown> = {}, transporteCustom?: Transporte_Email) {
  const config = Config_Teste(extra);
  const bd = new Banco_Falso();
  const transporte = transporteCustom ?? new Transporte_Simulado();
  const limitador = new Limitador_Taxa(config.RateLimit.JanelaSegundos * 1000, config.RateLimit.MaximoPorModulo, config.RateLimit.MaximoGlobal);
  const servico = new Config_Email(config, bd, transporte, new Templates_Email(NaRaiz(config.Email.PastaTemplates)), limitador);
  return { config, bd, transporte: transporte as Transporte_Simulado, servico };
}

function falhaCom(p: Promise<unknown>, codigo: string, trecho?: RegExp) {
  return assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof Erro_Email, `esperava Erro_Email, veio ${String(e)}`);
    assert.equal(e.codigo, codigo);
    if (trecho) assert.match(e.message, trecho);
    return true;
  });
}

test("envio simulado: entrega a mensagem, registra antes e depois e devolve o resultado", async () => {
  const { servico, bd, transporte } = montar();
  const r = await servico.Enviar(solicitante, JSON.stringify({ ...pedido, cc: ["cc@x.com"], bcc: ["bcc@x.com"], referencia: "fibramap:pv:7", responderPara: "resp@x.com" }));
  assert.equal(r.id, 1);
  assert.equal(r.destinatarios, 3);
  assert.equal(r.aceitos, 3);
  assert.equal(r.transporte, "simulado");
  assert.match(r.messageId, /^<simulado-/);

  assert.equal(transporte.Enviadas.length, 1);
  const m = transporte.Enviadas[0];
  assert.deepEqual([m.para, m.cc, m.bcc, m.assunto, m.texto, m.responderPara], [["ana@exemplo.com.br"], ["cc@x.com"], ["bcc@x.com"], "Teste", "Olá", "resp@x.com"]);

  // INSERT (enviando) antes, UPDATE (enviado) depois
  assert.equal(bd.inserts.length, 1);
  assert.match(bd.inserts[0].sql, /'enviando'/);
  assert.deepEqual(bd.inserts[0].valores.slice(0, 4), ["WSMod_FibraMap", null, "fibramap:pv:7", "ana@exemplo.com.br"]);
  assert.equal(bd.updates.length, 1);
  assert.deepEqual(bd.updates[0].valores.slice(0, 2), ["enviado", r.messageId]);
  assert.equal(bd.updates[0].valores[4], 1);
});

test("só HTML: gera a parte texto automaticamente", async () => {
  const { servico, transporte } = montar();
  await servico.Enviar(solicitante, { para: "a@x.com", assunto: "A", html: "<p>Olá <b>mundo</b></p>" });
  assert.equal(transporte.Enviadas[0].texto, "Olá mundo");
  assert.equal(transporte.Enviadas[0].html, "<p>Olá <b>mundo</b></p>");
});

test("template com variáveis: assunto e corpo vêm do template e o nome do template é registrado", async () => {
  const { servico, bd, transporte } = montar();
  await servico.Enviar(solicitante, { para: "a@x.com", template: "generico", variaveis: { titulo: "Aviso", mensagem: "<b>x</b>" } });
  const m = transporte.Enviadas[0];
  assert.equal(m.assunto, "Aviso");
  assert.match(m.html!, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.equal(bd.inserts[0].valores[7], "generico");
});

test("entrada inválida é recusada ANTES de qualquer registro ou envio", async () => {
  const { servico, bd, transporte } = montar();
  await falhaCom(servico.Enviar(solicitante, { para: "ruim", assunto: "a", texto: "b" }), "validacao");
  await falhaCom(servico.Enviar(solicitante, { para: "a@x.com", template: "nao_existe" }), "template_invalido");
  await falhaCom(servico.Enviar(solicitante, { para: "a@x.com", template: "generico", variaveis: {} }), "validacao", /Faltam variáveis/);
  assert.equal(bd.inserts.length, 0);
  assert.equal(transporte.Enviadas.length, 0);
});

test("rate limit por módulo: excedido recusa sem registrar nem enviar", async () => {
  const { servico, bd, transporte } = montar({ RateLimit: { MaximoPorModulo: 2 } });
  await servico.Enviar(solicitante, pedido);
  await servico.Enviar(solicitante, pedido);
  await falhaCom(servico.Enviar(solicitante, pedido), "limite_excedido");
  assert.equal(transporte.Enviadas.length, 2);
  assert.equal(bd.inserts.length, 2);
  // outro módulo segue livre
  await servico.Enviar({ modulo: "WSMod_Outro", usuarioId: null }, pedido);
});

test("falha do transporte: registra 'falhou', devolve erro mapeado e não vaza segredo", async () => {
  const { servico, bd, transporte, config } = montar({ SMTP: { Senha: "SenhaSuperSecreta123", Usuario: "AKIAUSUARIOSES" } });
  transporte.FalharCom = Object.assign(new Error("Invalid login: 535 Authentication failed for AKIAUSUARIOSES with SenhaSuperSecreta123 (ana@exemplo.com.br)"), { code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" });
  await assert.rejects(servico.Enviar(solicitante, pedido), (e: unknown) => {
    assert.ok(e instanceof Erro_Email);
    assert.equal(e.codigo, "smtp_autenticacao");
    assert.doesNotMatch(e.message, /SenhaSuperSecreta123|AKIAUSUARIOSES/);
    return true;
  });
  const u = bd.updates[0];
  assert.equal(u.valores[0], "falhou");
  assert.equal(u.valores[2], "smtp_autenticacao");
  const textoErro = String(u.valores[3]);
  assert.match(textoErro, /EAUTH/);
  assert.doesNotMatch(textoErro, /SenhaSuperSecreta123|AKIAUSUARIOSES/);
  assert.doesNotMatch(textoErro, /ana@exemplo/, "e-mails ficam mascarados no texto do erro");
  assert.ok(config.SMTP.Senha); // (garante que o teste usou mesmo um segredo)
});

test("códigos de erro do SMTP viram mensagens claras", async () => {
  const casos: Array<[Record<string, unknown>, string, RegExp]> = [
    [{ code: "ECONNECTION" }, "smtp_conexao", /SMTP\.Host/],
    [{ code: "ETIMEDOUT" }, "smtp_timeout", /Tempo esgotado/],
    [{ code: "EENVELOPE" }, "smtp_destinatario", /recusou/],
    [{ responseCode: 554 }, "smtp_erro", /verificado/],
    [{}, "smtp_erro", /Falha ao enviar/],
  ];
  for (const [props, codigo, trecho] of casos) {
    const { servico, transporte } = montar();
    transporte.FalharCom = Object.assign(new Error("x"), props);
    await falhaCom(servico.Enviar(solicitante, pedido), codigo, trecho);
  }
});

test("sem registrar no banco, NÃO envia", async () => {
  const { servico, bd, transporte } = montar();
  bd.falharInsert = true;
  await falhaCom(servico.Enviar(solicitante, pedido), "interno", /não foi enviado/);
  assert.equal(transporte.Enviadas.length, 0);
});

test("falha ao atualizar o registro depois do envio não derruba o resultado", async () => {
  const { servico, bd, transporte } = montar();
  bd.falharUpdate = true;
  const r = await servico.Enviar(solicitante, pedido);
  assert.equal(transporte.Enviadas.length, 1);
  assert.equal(r.id, 1);
});

test("SMTP não configurado: erro claro dizendo o que preencher, registrado como falha", async () => {
  const config = Config_Teste({ SMTP: { Modo: "smtp" } });
  const bd = new Banco_Falso();
  const servico = new Config_Email(config, bd, new Transporte_SMTP(config.SMTP, () => { throw new Error("não deveria criar conexão"); }),
    new Templates_Email(NaRaiz(config.Email.PastaTemplates)), new Limitador_Taxa(60_000, 30, 120));
  await assert.rejects(servico.Enviar(solicitante, pedido), (e: unknown) => {
    assert.ok(e instanceof Erro_Email);
    assert.equal(e.codigo, "nao_configurado");
    assert.match(e.message, /SMTP\.Host, SMTP\.Usuario, SMTP\.Senha, SMTP\.Remetente/);
    return true;
  });
  assert.equal(bd.updates[0].valores[0], "falhou");
  assert.equal(bd.updates[0].valores[2], "nao_configurado");
});

test("Ping informa transporte e se está configurado, sem expor segredos", async () => {
  const smtp = montar({ SMTP: { Modo: "smtp", Host: "email-smtp.us-east-1.amazonaws.com", Usuario: "U1234", Senha: "S3gredo!", Remetente: "TurboOne <nao-responda@exemplo.com.br>" } });
  const naoConfigurado = montar({ SMTP: { Modo: "smtp" } });
  const config: Modelo_Configuracao = smtp.config;
  const comSmtp = new Config_Email(config, smtp.bd, new Transporte_SMTP(config.SMTP), new Templates_Email(NaRaiz(config.Email.PastaTemplates)), new Limitador_Taxa(1000, 1, 1));
  const p1 = await comSmtp.Ping();
  assert.deepEqual(p1, { modulo: "WSCore_Email", versao: "0.1.0", transporte: "smtp", configurado: true });
  assert.doesNotMatch(JSON.stringify(p1), /S3gredo|U1234|amazonaws/);

  const semConfig = new Config_Email(naoConfigurado.config, naoConfigurado.bd, new Transporte_SMTP(naoConfigurado.config.SMTP), new Templates_Email(NaRaiz("./Server/Templates")), new Limitador_Taxa(1000, 1, 1));
  assert.equal((await semConfig.Ping()).configurado, false);
  assert.equal((await montar().servico.Ping()).transporte, "simulado");
});
