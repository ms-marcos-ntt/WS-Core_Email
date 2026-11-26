/**
 * Transporte SMTP (com nodemailer simulado por injeção) e configuração.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Config_Teste } from "./Helpers";
import { Criar_Transporte, Problemas_Config_SMTP, Transporte_SMTP, Transporte_Simulado, Validar_Remetente } from "../Server/Controllers/Email/Transporte_Email";
import { Mesclar_Com_Padrao } from "../Server/Controllers/Lib/Configuracao";
import { Mascarar_Segredos } from "../Server/Controllers/Lib/Erros";
import { Erro_Email, Mensagem_Pronta } from "../Server/Models/Email/Tipos";

const smtpOk = { Modo: "smtp" as const, Host: "email-smtp.us-east-1.amazonaws.com", Porta: 587, Seguro: false, Usuario: "AKIAEXEMPLO", Senha: "senha-exemplo", Remetente: "TurboOne <nao-responda@exemplo.com.br>", TimeoutMs: 5000 };
const mensagem: Mensagem_Pronta = { de: "x", para: ["a@x.com"], cc: [], bcc: ["b@x.com"], assunto: "A", texto: "t", html: "<p>t</p>", anexos: [{ nome: "a.pdf", conteudo: Buffer.from("pdf"), tipo: "application/pdf" }], responderPara: "r@x.com" };

test("config padrão: SMTP vazio (sem segredo versionado) e modo smtp", () => {
  const c = Mesclar_Com_Padrao({});
  assert.deepEqual([c.SMTP.Host, c.SMTP.Usuario, c.SMTP.Senha, c.SMTP.Remetente, c.SMTP.Modo], ["", "", "", "", "smtp"]);
  assert.deepEqual(c.Autorizacao.ModulosPermitidos, ["WSMod_FibraMap"]);
  assert.equal(c.Autorizacao.ExigirPermissaoUsuario, false);
});

test("Mesclar_Com_Padrao completa blocos aninhados e deixa listas do config substituírem as do modelo", () => {
  const c = Mesclar_Com_Padrao({ Email: { Limites: { MaxAnexos: 1 } }, Autorizacao: { ModulosPermitidos: ["A", "B"] } });
  assert.equal(c.Email.Limites.MaxAnexos, 1);
  assert.equal(c.Email.Limites.MaxDestinatarios, 50);
  assert.equal(c.Email.PastaTemplates, "./Server/Templates");
  assert.deepEqual(c.Autorizacao.ModulosPermitidos, ["A", "B"]);
});

test("Problemas_Config_SMTP lista o que falta sem mostrar valores", () => {
  assert.deepEqual(Problemas_Config_SMTP(Config_Teste({ SMTP: { Modo: "smtp" } }).SMTP), ["SMTP.Host", "SMTP.Usuario", "SMTP.Senha", "SMTP.Remetente"]);
  assert.deepEqual(Problemas_Config_SMTP(smtpOk), []);
  assert.deepEqual(Problemas_Config_SMTP({ ...smtpOk, Porta: 0 }), ["SMTP.Porta"]);
  assert.match(Problemas_Config_SMTP({ ...smtpOk, Remetente: "isto não é e-mail" })[0], /SMTP\.Remetente \(formato inválido/);
});

test("Validar_Remetente aceita endereço puro e 'Nome <endereço>'", () => {
  assert.equal(Validar_Remetente("nao-responda@exemplo.com.br"), "nao-responda@exemplo.com.br");
  assert.equal(Validar_Remetente("TurboOne <Nao-Responda@Exemplo.com.br>"), "\"TurboOne\" <nao-responda@exemplo.com.br>");
  assert.equal(Validar_Remetente("Nome\r\nBcc: x@y.com <a@b.com>"), undefined);
  assert.equal(Validar_Remetente("<>"), undefined);
});

test("Transporte_SMTP: opções seguras (STARTTLS obrigatório, sem acesso a arquivo/URL) e mensagem montada", async () => {
  let opcoes: Record<string, any> = {};
  let enviado: Record<string, any> = {};
  const t = new Transporte_SMTP(smtpOk, (o) => {
    opcoes = o as Record<string, any>;
    return { sendMail: async (m: Record<string, any>) => { enviado = m; return { messageId: "<id@ses>", accepted: ["a@x.com", "b@x.com"], rejected: [] }; }, close: () => undefined } as any;
  });
  const r = await t.Enviar(mensagem);
  assert.deepEqual(r, { messageId: "<id@ses>", aceitos: ["a@x.com", "b@x.com"], recusados: [] });

  assert.equal(opcoes.host, smtpOk.Host);
  assert.equal(opcoes.port, 587);
  assert.equal(opcoes.secure, false);
  assert.equal(opcoes.requireTLS, true);
  assert.equal(opcoes.disableFileAccess, true);
  assert.equal(opcoes.disableUrlAccess, true);
  assert.deepEqual(opcoes.auth, { user: "AKIAEXEMPLO", pass: "senha-exemplo" });
  assert.equal(opcoes.tls.minVersion, "TLSv1.2");

  assert.equal(enviado.from, "\"TurboOne\" <nao-responda@exemplo.com.br>");
  assert.deepEqual([enviado.to, enviado.cc, enviado.bcc, enviado.replyTo], [["a@x.com"], undefined, ["b@x.com"], "r@x.com"]);
  assert.deepEqual(enviado.attachments, [{ filename: "a.pdf", content: Buffer.from("pdf"), contentType: "application/pdf" }]);
});

test("Transporte_SMTP: porta 465 com Seguro=true usa TLS direto", async () => {
  let opcoes: Record<string, any> = {};
  const t = new Transporte_SMTP({ ...smtpOk, Porta: 465, Seguro: true }, (o) => {
    opcoes = o as Record<string, any>;
    return { sendMail: async () => ({ messageId: "<i>", accepted: ["a@x.com"], rejected: [] }), close: () => undefined } as any;
  });
  await t.Enviar(mensagem);
  assert.equal(opcoes.secure, true);
  assert.equal(opcoes.requireTLS, false);
});

test("Transporte_SMTP: cria a conexão uma vez só e recria após Fechar", async () => {
  let criacoes = 0;
  const t = new Transporte_SMTP(smtpOk, () => { criacoes++; return { sendMail: async () => ({ messageId: "<i>", accepted: ["a@x.com"], rejected: [] }), close: () => undefined } as any; });
  await t.Enviar(mensagem); await t.Enviar(mensagem);
  assert.equal(criacoes, 1);
  t.Fechar();
  await t.Enviar(mensagem);
  assert.equal(criacoes, 2);
});

test("Transporte_SMTP: todos os destinatários recusados é erro; recusa parcial é sucesso informando", async () => {
  const com = (accepted: string[], rejected: string[]) => new Transporte_SMTP(smtpOk, () => ({ sendMail: async () => ({ messageId: "<i>", accepted, rejected }), close: () => undefined }) as any);
  await assert.rejects(com([], ["a@x.com"]).Enviar(mensagem), (e: unknown) => e instanceof Erro_Email && e.codigo === "smtp_destinatario");
  const parcial = await com(["a@x.com"], ["b@x.com"]).Enviar(mensagem);
  assert.deepEqual([parcial.aceitos, parcial.recusados], [["a@x.com"], ["b@x.com"]]);
});

test("Transporte_SMTP sem configuração não chega a criar conexão", async () => {
  const t = new Transporte_SMTP(Config_Teste({ SMTP: { Modo: "smtp" } }).SMTP, () => { throw new Error("não deveria criar"); });
  await assert.rejects(t.Enviar(mensagem), (e: unknown) => e instanceof Erro_Email && e.codigo === "nao_configurado");
  assert.throws(() => t.Verificar(), /não configurado/);
});

test("Criar_Transporte escolhe pelo SMTP.Modo", () => {
  assert.ok(Criar_Transporte(Config_Teste().SMTP) instanceof Transporte_Simulado);
  assert.ok(Criar_Transporte(Config_Teste({ SMTP: { Modo: "smtp" } }).SMTP) instanceof Transporte_SMTP);
  assert.throws(() => Criar_Transporte({ ...smtpOk, Modo: "outro" as any }), (e: unknown) => e instanceof Erro_Email && e.codigo === "nao_configurado");
});

test("Mascarar_Segredos remove o segredo e sua forma base64 (AUTH do SMTP)", () => {
  const b64 = Buffer.from("senha-exemplo").toString("base64");
  const texto = `falhou com senha-exemplo e ${b64} para AKIAEXEMPLO`;
  assert.equal(Mascarar_Segredos(texto, ["senha-exemplo", "AKIAEXEMPLO", undefined, ""]), "falhou com [segredo] e [segredo] para [segredo]");
});
