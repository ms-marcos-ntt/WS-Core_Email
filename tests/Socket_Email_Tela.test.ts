/**
 * Eventos da tela: autorização por usuário/permissão (fail-closed), resumo do painel e controle.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Banco_Falso, Config_Teste } from "./Helpers";
import { Autenticador_Cliente } from "../Server/Controllers/Lib/Autenticador_Cliente";
import { Historico_Email } from "../Server/Controllers/Email/Historico_Email";
import { Servico_Controle } from "../Server/Controllers/Email/Controle_Email";
import { Relogio } from "../Server/Controllers/Email/Relogio_Email";
import { PERMISSAO_ADMINISTRAR, PERMISSAO_VISUALIZAR, Socket_Email_Tela } from "../Server/Controllers/Email/Socket_Email_Tela";
import { Pacotes_Socket } from "../Server/Models/Modulos/Pacotes_Socket";

type Handler = (pacote: Pacotes_Socket, cb: (r: any) => void) => unknown;

/** Autenticador real (Autenticador_Cliente) conversando com um "Autenticador" falso por emit — o mesmo caminho de produção. */
function autenticadorFalso(usuarios: Record<string, { id: number; permissoes: string[] }>, estado: { fora?: boolean } = {}) {
  const chamadas: Array<{ evento: string; token: string; dados: any }> = [];
  const emit = (evento: string, _destino: string, token: string, dados: any, cb?: (...r: any[]) => void) => {
    chamadas.push({ evento, token, dados });
    if (estado.fora) { cb?.({ status: "Erro", mensagem: "Core indisponível no momento" }); return; }
    const u = usuarios[token];
    if (evento === "usuarios/logintoken") { cb?.(u ? { login: "OK", id: u.id } : { login: "Erro", status: "Erro" }); return; }
    if (evento === "usuarios/autorizar") { cb?.(u && u.permissoes.includes(dados.permissao) ? { status: "OK" } : { status: "Erro", mensagem: "Sem permissão" }); return; }
  };
  return { cliente: new Autenticador_Cliente({ emit }), chamadas };
}

function montar(usuarios: Record<string, { id: number; permissoes: string[] }>, estado: { fora?: boolean } = {}, extraConfig: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>();
  const core = { Escutar: (evento: string, h: Handler) => { handlers.set(evento, h); } } as any;
  const bd = new Banco_Falso();
  const relogio = new Relogio(() => new Date("2026-11-26T15:00:00Z"));
  const controle = new Servico_Controle(bd, relogio);
  const { cliente, chamadas } = autenticadorFalso(usuarios, estado);
  const config = Config_Teste({ SMTP: { Senha: "SenhaSecretaSMTP", Usuario: "USUARIOSMTP", Host: "email-smtp.exemplo.amazonaws.com", Remetente: "TurboOne <x@y.com>", Modo: "simulado", ...extraConfig } });
  new Socket_Email_Tela(core, config, bd, new Historico_Email(bd), controle, cliente, relogio).Registrar();
  const chamar = (evento: string, token: string | undefined, dados: unknown = {}) => new Promise<any>((resolve) => {
    const pacote = { evento, destino: "WSCore_Email/*", origem: "id-webserver", token: token as string, dados: JSON.stringify(dados) };
    void handlers.get(evento)!(pacote, resolve);
  });
  return { bd, chamar, handlers, chamadas };
}

const USUARIOS = {
  "tk-ver": { id: 10, permissoes: [PERMISSAO_VISUALIZAR] },
  "tk-adm": { id: 20, permissoes: [PERMISSAO_VISUALIZAR, PERMISSAO_ADMINISTRAR] },
  "tk-so-adm": { id: 30, permissoes: [PERMISSAO_ADMINISTRAR] },
  "tk-nada": { id: 40, permissoes: [] },
};
const EVENTOS_VER = ["email/historico/listar", "email/historico/obter", "email/historico/opcoes", "email/uso/resumo"];
const TODOS = [...EVENTOS_VER, "email/controle/salvar"];

test("as permissões novas têm os códigos combinados", () => {
  assert.equal(PERMISSAO_VISUALIZAR, "email.visualizar");
  assert.equal(PERMISSAO_ADMINISTRAR, "email.administrar");
});

test("registra todos os eventos da tela", () => {
  const { handlers } = montar(USUARIOS);
  assert.deepEqual([...handlers.keys()].sort(), [...TODOS].sort());
});

test("sem token, token inválido ou sem a permissão: recusa TODOS os eventos e não toca no banco", async () => {
  for (const token of [undefined, "", "token-invalido", "tk-nada"]) {
    const { chamar, bd } = montar(USUARIOS);
    for (const evento of TODOS) {
      const r = await chamar(evento, token, { id: 1, limiteDiario: 10 });
      assert.equal(r.status, "Erro", `${evento} com token ${JSON.stringify(token)}`);
      assert.equal(r.codigo, "nao_autorizado", `${evento} com token ${JSON.stringify(token)}`);
    }
    assert.equal(bd.chamadas.length, 0, "nenhuma consulta/gravação antes de autorizar");
  }
});

test("quem só visualiza vê histórico/uso mas NÃO altera limites; quem só administra NÃO visualiza", async () => {
  const { chamar, bd } = montar(USUARIOS);
  for (const evento of EVENTOS_VER) {
    const r = await chamar(evento, "tk-ver", { id: 1 });
    assert.notEqual(r.codigo, "nao_autorizado", evento);
  }
  const negado = await chamar("email/controle/salvar", "tk-ver", { limiteDiario: 100 });
  assert.deepEqual([negado.status, negado.codigo, negado.mensagem], ["Erro", "nao_autorizado", "Sem permissão"]);
  assert.equal(bd.chamadas.some((c) => /_Core_Email_Configuracao/.test(c.sql) && /^\s*INSERT/i.test(c.sql)), false);

  const soAdm = montar(USUARIOS);
  for (const evento of EVENTOS_VIAS()) assert.equal((await soAdm.chamar(evento, "tk-so-adm", {})).codigo, "nao_autorizado", evento);
});
function EVENTOS_VIAS() { return EVENTOS_VER; }

test("Autenticador indisponível: recusa (fail-closed) e informa o motivo", async () => {
  const { chamar } = montar(USUARIOS, { fora: true });
  const r = await chamar("email/uso/resumo", "tk-adm");
  assert.deepEqual([r.status, r.codigo], ["Erro", "nao_autorizado"]);
  assert.match(r.mensagem, /Autenticador indisponível/);
});

test("a autorização usa o token do usuário e a permissão certa no Autenticador", async () => {
  const { chamar, chamadas } = montar(USUARIOS);
  await chamar("email/historico/listar", "tk-ver");
  assert.ok(chamadas.some((c) => c.evento === "usuarios/logintoken" && c.token === "tk-ver"));
  assert.ok(chamadas.some((c) => c.evento === "usuarios/autorizar" && c.dados.permissao === "email.visualizar"));
  chamadas.length = 0;
  await chamar("email/controle/salvar", "tk-adm", { pausado: true });
  assert.ok(chamadas.some((c) => c.evento === "usuarios/autorizar" && c.dados.permissao === "email.administrar"));
});

test("email/controle/salvar: administrador altera; valida a entrada; grava o id de quem alterou", async () => {
  const { chamar, bd } = montar(USUARIOS);
  const r = await chamar("email/controle/salvar", "tk-adm", { limiteDiario: 200, limiteMensal: 4000, percentualAlerta: 75, pausado: false });
  assert.equal(r.status, "OK");
  assert.deepEqual(r.dados.alterados.sort(), ["limite_diario", "limite_mensal", "percentual_alerta"]);
  const hist = bd.chamadas.filter((c) => /INSERT INTO _Core_Email_Configuracao_Historico/.test(c.sql));
  assert.equal(hist.length, 3);
  assert.ok(hist.every((c) => c.valores[3] === 20), "alterado_por = usuário do token");

  const ruim = await chamar("email/controle/salvar", "tk-adm", { limiteDiario: -1 });
  assert.deepEqual([ruim.status, ruim.codigo], ["Erro", "validacao"]);
  const txt = await chamar("email/controle/salvar", "tk-adm", { limiteDiario: "9; DROP TABLE x" });
  assert.equal(txt.codigo, "validacao");
});

test("email/uso/resumo: valida período, informa podeAdministrar e não expõe credenciais do config", async () => {
  const { chamar } = montar(USUARIOS);
  const adm = await chamar("email/uso/resumo", "tk-adm", { periodo: 30 });
  assert.equal(adm.status, "OK");
  assert.equal(adm.dados.podeAdministrar, true);
  assert.equal(adm.dados.periodo, 30);
  assert.equal(adm.dados.serie.length, 30);
  assert.deepEqual(adm.dados.controle.limiteDiario, 0);
  assert.equal(adm.dados.diario.faixa, "sem_limite");

  const ver = await chamar("email/uso/resumo", "tk-ver");
  assert.equal(ver.dados.podeAdministrar, false);
  assert.equal(ver.dados.periodo, 7);
  assert.deepEqual(ver.dados.configCfg.smtp, { modo: "simulado", configurado: true });

  const json = JSON.stringify(adm);
  for (const segredo of ["SenhaSecretaSMTP", "USUARIOSMTP", "amazonaws", "x@y.com"]) assert.ok(!json.includes(segredo), `vazou ${segredo}`);
  assert.deepEqual(Object.keys(adm.dados.configCfg).sort(), ["exigirPermissaoUsuario", "limites", "modulosPermitidos", "rateLimit", "smtp"]);

  const ruim = await chamar("email/uso/resumo", "tk-ver", { periodo: 15 });
  assert.equal(ruim.codigo, "validacao");
});

test("email/uso/resumo: aviso quando passa do % de alerta e quando está pausado", async () => {
  const { chamar, bd } = montar(USUARIOS);
  bd.respostas.push(
    { padrao: /FROM _Core_Email_Configuracao$/, linhas: [{ chave: "limite_diario", valor: "100", alterado_por: 20, alterado_em: "2026-11-26 08:00:00.000" }, { chave: "pausado", valor: "1", alterado_por: 20, alterado_em: "2026-11-26 08:00:00.000" }] },
    { padrao: /SUM\(CASE WHEN criado_em/, linhas: [{ hora: 5, hoje: 85, mes: 85 }] },
  );
  const r = await chamar("email/uso/resumo", "tk-ver");
  assert.deepEqual(r.dados.diario, { usado: 85, limite: 100, percentual: 85, faixa: "alerta" });
  assert.deepEqual(r.dados.avisos.map((a: any) => a.codigo), ["pausado", "diario_alerta"]);
});

test("handler com dados inválidos (JSON quebrado) responde validação, não derruba", async () => {
  const { handlers } = montar(USUARIOS);
  const r = await new Promise<any>((resolve) => void handlers.get("email/historico/listar")!({ evento: "x", destino: "", origem: "", token: "tk-ver", dados: "{quebrado" }, resolve));
  assert.deepEqual([r.status, r.codigo], ["Erro", "validacao"]);
});

test("email/uso/resumo: SMTP real sem credenciais completas aparece como NÃO configurado", async () => {
  const { chamar } = montar(USUARIOS, {}, { Modo: "smtp", Senha: "" });
  const r = await chamar("email/uso/resumo", "tk-ver");
  assert.deepEqual(r.dados.configCfg.smtp, { modo: "smtp", configurado: false });
});
