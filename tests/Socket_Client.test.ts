/**
 * Testes do cliente do Core (registro, reconexão, respostas de erro) contra um Core falso.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import { AddressInfo } from "net";
import { Server, Socket } from "socket.io";
import { Socket_Client } from "../Server/Controllers/Modulos/Socket_Client";
import { Modulos_Struct } from "../Server/Models/Modulos/Modulos_Struct";
import { Logger } from "../Server/Controllers/Lib/Logger";

Logger.Configurar({ Console: false, Arquivo: false });

interface Core_Falso {
    io: Server;
    porta: number;
    registros: Array<Record<string, unknown>>;
    modulo?: Socket;
    fechar(): Promise<void>;
}

/** Core mínimo: faz o handshake e guarda o socket do módulo registrado. */
function CriarCoreFalso(porta = 0): Promise<Core_Falso> {
    return new Promise((resolve) => {
        const httpServer = http.createServer();
        const ioServer = new Server(httpServer);
        const core: Core_Falso = {
            io: ioServer,
            porta: 0,
            registros: [],
            fechar: () => new Promise((r) => ioServer.close(() => r())),
        };
        ioServer.on("connection", (s) => {
            s.once("init/modulos/end_setup", (dados: Record<string, unknown>) => {
                core.registros.push(dados);
                core.modulo = s;
                s.emit("init/modulos/ack", {});
            });
            s.emit("init/modulos/setup", { Modulo_ID: "id-" + core.registros.length });
        });
        httpServer.listen(porta, "127.0.0.1", () => {
            core.porta = (httpServer.address() as AddressInfo).port;
            resolve(core);
        });
    });
}

function NovoCliente(porta: number, extra: Record<string, unknown> = {}): Socket_Client {
    const dados = new Modulos_Struct();
    dados.Modulo_Nome = "Teste";
    dados.Modulo_Versao = "1";
    return new Socket_Client({ host: "127.0.0.1", porta, timeoutMs: 500, ...extra }, dados);
}

/** Envia um pacote do Core para o módulo e aguarda a resposta do handler. */
function CoreEnvia(core: Core_Falso, evento: string, dados: unknown = {}): Promise<any> {
    return new Promise((resolve) => core.modulo!.emit(evento, { evento, dados: JSON.stringify(dados), token: "" }, resolve));
}

const abertos: Array<{ c?: Socket_Client; core?: Core_Falso }> = [];
after(async () => {
    for (const a of abertos) {
        a.c?.Desconectar();
        await a.core?.fechar();
    }
});


test("registra no Core enviando o ID recebido e o segredo configurado", async () => {
    const core = await CriarCoreFalso();
    const c = NovoCliente(core.porta, { segredo: "abc" });
    abertos.push({ c, core });
    await c.Connect();
    assert.equal(c.Registrado, true);
    assert.equal(core.registros[0].Modulo_Nome, "Teste");
    assert.equal(core.registros[0].Modulo_ID, "id-0");
    assert.equal(core.registros[0].Modulo_Segredo, "abc");
});

test("sem segredo configurado não envia Modulo_Segredo", async () => {
    const core = await CriarCoreFalso();
    const c = NovoCliente(core.porta);
    abertos.push({ c, core });
    await c.Connect();
    assert.equal("Modulo_Segredo" in core.registros[0], false);
});

test("refaz o registro sozinho quando o Core reinicia", async () => {
    const core1 = await CriarCoreFalso();
    const porta = core1.porta;
    const c = NovoCliente(porta);
    abertos.push({ c });
    await c.Connect();
    await core1.fechar();

    const core2 = await CriarCoreFalso(porta);
    abertos.push({ core: core2 });
    const inicio = Date.now();
    while (core2.registros.length === 0 && Date.now() - inicio < 8000) {
        await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(core2.registros.length, 1, "módulo deveria ter se registrado no Core reiniciado");
});

test("Escutar: exceção no handler vira resposta de erro e o processo segue", async () => {
    const core = await CriarCoreFalso();
    const c = NovoCliente(core.porta);
    abertos.push({ c, core });
    c.Escutar("quebra", () => { throw new Error("boom"); });
    c.Escutar("json", (p: any, cb) => cb(JSON.parse(p.dados)));
    await c.Connect();

    const r = await CoreEnvia(core, "quebra");
    assert.equal(r.status, "Erro");
    assert.deepEqual(await CoreEnvia(core, "json", { a: 1 }), { a: 1 });
});

test("Escutar: Promise rejeitada vira resposta de erro; callback só responde uma vez", async () => {
    const core = await CriarCoreFalso();
    const c = NovoCliente(core.porta);
    abertos.push({ c, core });
    c.Escutar("async", async () => { throw new Error("falhou"); });
    c.Escutar("duplo", (_p, cb) => { cb("primeira"); cb("segunda"); });
    await c.Connect();

    assert.equal((await CoreEnvia(core, "async")).status, "Erro");
    assert.equal(await CoreEnvia(core, "duplo"), "primeira");
});

test("emit: responde erro na hora se não estiver registrado", async () => {
    const c = NovoCliente(1); // porta sem Core
    abertos.push({ c });
    const r = await new Promise<any>((resolve) => c.emit("x", "Destino", "", {}, resolve));
    assert.equal(r.status, "Erro");
    assert.match(r.mensagem, /indisponível/);
});

test("emit: tempo esgotado quando o Core não responde", async () => {
    const core = await CriarCoreFalso();
    const c = NovoCliente(core.porta);
    abertos.push({ c, core });
    await c.Connect();
    core.modulo!.on("Pacote_Socket", () => { /* Core mudo */ });
    const r = await new Promise<any>((resolve) => c.emit("x", "Destino", "", {}, resolve));
    assert.equal(r.status, "Erro");
    assert.match(r.mensagem, /Tempo esgotado/);
});

test("emit: entrega a resposta do Core", async () => {
    const core = await CriarCoreFalso();
    const c = NovoCliente(core.porta);
    abertos.push({ c, core });
    await c.Connect();
    core.modulo!.on("Pacote_Socket", (p: any, cb: Function) => cb({ status: "OK", eco: JSON.parse(p.dados), token: p.token }));
    const r = await new Promise<any>((resolve) => c.emit("x", "Destino", "tok", { b: 2 }, resolve));
    assert.deepEqual(r, { status: "OK", eco: { b: 2 }, token: "tok" });
});
