import { io, Socket } from "socket.io-client";
import { Logger } from "../Lib/Logger";
import { Pacotes_Socket } from "../../Models/Modulos/Pacotes_Socket";
import { Modulos_Struct } from "../../Models/Modulos/Modulos_Struct";
import { Descrever_Erro } from "../Lib/Erros";


type Callback = (...retorno: any[]) => void;

/**
 * Opções de conexão com o Core (bloco "Core" do config.cfg).
 */
export interface Opcoes_Socket_Client {
    // Endereço do Core
    host: string;
    // Porta do Core
    porta: number;
    // Segredo enviado no handshake (Core.SegredoModulos no Core). Vazio = não envia.
    segredo: string;
    // Tempo máximo (ms) aguardando a resposta de um pacote. Deve ser maior que o TimeoutRepasseMs do Core.
    timeoutMs: number;
}

const OPCOES_PADRAO: Opcoes_Socket_Client = {
    host: "127.0.0.1",
    porta: 7000,
    segredo: "",
    timeoutMs: 35000,
};


/**
 * Cliente Socket.IO do módulo com o Core.
 *
 * - Refaz o registro (init/modulos/setup -> end_setup) a cada reconexão, então o módulo
 *   volta a receber pacotes sozinho quando o Core reinicia.
 * - Toda chamada com callback recebe resposta: a do destino ou { status: "Erro", mensagem }.
 * - `Escutar` protege os handlers: exceção ou Promise rejeitada vira resposta de erro em vez de
 *   derrubar o processo ou deixar o remetente esperando.
 */
export class Socket_Client {

    public socketClient: Socket;

    public Modulo_Dados: Modulos_Struct;

    private opcoes: Opcoes_Socket_Client;

    private _Logger: Logger = new Logger();

    private registrado = false;

    // Evita repetir o mesmo log a cada tentativa de reconexão
    private ultimoErroConexao = "";


    constructor(opcoes: Partial<Opcoes_Socket_Client>, dados_modulos: Modulos_Struct) {
        this.opcoes = { ...OPCOES_PADRAO, ...opcoes };
        this.Modulo_Dados = dados_modulos;

        // autoConnect: false -> os listeners podem ser registrados antes da conexão,
        // sem janela em que o Core roteia um pacote para um evento ainda sem handler.
        this.socketClient = io("http://" + this.opcoes.host + ":" + this.opcoes.porta, {
            autoConnect: false,
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 10000,
        });

        this.socketClient.on("connect", () => {
            this.ultimoErroConexao = "";
            this._Logger.System("[ClienteSocket] Conectado ao Core:", this.Endereco());
        });

        // O Core envia o setup a cada nova conexão, inclusive reconexões.
        this.socketClient.on("init/modulos/setup", (modData: Partial<Modulos_Struct>) => {
            if (modData && typeof modData.Modulo_ID === "string" && modData.Modulo_ID !== "") {
                this.Modulo_Dados.Modulo_ID = modData.Modulo_ID;
            }
            const dados: Record<string, unknown> = { ...this.Modulo_Dados.toJson() };
            if (this.opcoes.segredo !== "") {
                dados.Modulo_Segredo = this.opcoes.segredo;
            }
            this.socketClient.emit("init/modulos/end_setup", dados);
        });

        this.socketClient.on("init/modulos/ack", () => {
            this.registrado = true;
            this._Logger.System("[ClienteSocket] Módulo registrado no Core:", this.Modulo_Dados.Modulo_Nome);
        });

        this.socketClient.on("disconnect", (motivo: string) => {
            this.registrado = false;
            this._Logger.Warning("[ClienteSocket] Desconectado do Core:", motivo,
                motivo === "io server disconnect" ? "(recusado pelo Core: confira nome/segredo do módulo)" : "- tentando reconectar");
        });

        this.socketClient.on("connect_error", (err: Error) => {
            if (err.message !== this.ultimoErroConexao) {
                this.ultimoErroConexao = err.message;
                this._Logger.Warning("[ClienteSocket] Core indisponível em", this.Endereco(), "-", err.message, "(tentando novamente)");
            }
        });
    }


    /** Indica se o módulo está conectado e registrado no Core. */
    get Registrado(): boolean {
        return this.registrado && this.socketClient.connected;
    }


    /**
     * Conecta ao Core e resolve quando o módulo estiver registrado (ack recebido).
     * Se o Core estiver fora do ar, continua tentando até ele subir.
     */
    Connect(): Promise<void> {
        return new Promise<void>((resolv) => {
            if (this.Registrado) {
                resolv();
                return;
            }
            this.socketClient.once("init/modulos/ack", () => resolv());
            this._Logger.System("[ClienteSocket] Iniciando conexão com o Core:", this.Endereco());
            this.socketClient.connect();
        });
    }


    /** Encerra a conexão com o Core (desligamento do processo). */
    Desconectar(): void {
        this.socketClient.close();
    }


    /**
     * Registra o handler de um evento recebido do Core.
     * Exceções e Promises rejeitadas viram resposta { status: "Erro" } ao remetente.
     * O callback só é chamado uma vez, mesmo que o handler o chame de novo.
     */
    Escutar(evento: string, handler: (pacote: any, callback: Callback) => unknown): void {
        this.socketClient.on(evento, (pacote: unknown, callback?: unknown) => {
            let respondeu = false;
            const responder: Callback = (...retorno: any[]) => {
                if (respondeu) return;
                respondeu = true;
                if (typeof callback === "function") callback(...retorno);
            };
            const falhar = (err: unknown) => {
                this._Logger.Error("[ClienteSocket] Erro no handler do evento", evento + ":", Descrever_Erro(err));
                responder({ status: "Erro", mensagem: "Erro interno ao processar " + evento });
            };

            try {
                const resultado = handler(pacote, responder);
                if (resultado && typeof (resultado as Promise<unknown>).then === "function") {
                    (resultado as Promise<unknown>).catch(falhar);
                }
            } catch (err) {
                falhar(err);
            }
        });
    }


    /**
     * Envia um pacote ao Core para ser roteado ao módulo de destino.
     * Com callback: sempre responde (resposta do destino, ou erro se o Core estiver fora / tempo esgotado).
     * Sem callback: envio sem resposta; descartado se o Core estiver fora.
     */
    emit(evento: string, destino: string, token: string, dados: Object, callback?: Callback): void {
        const PacoteModulo: Pacotes_Socket = {
            destino,
            evento,
            origem: this.Modulo_Dados.Modulo_ID,
            token,
            dados: JSON.stringify(dados),
        };

        if (!this.Registrado) {
            this._Logger.Warning("[ClienteSocket] Core indisponível, pacote não enviado. evento:", evento, "destino:", destino);
            callback?.({ status: "Erro", mensagem: "Core indisponível no momento" });
            return;
        }

        if (!callback) {
            this.socketClient.emit("Pacote_Socket", PacoteModulo);
            return;
        }

        this.socketClient.timeout(this.opcoes.timeoutMs).emit("Pacote_Socket", PacoteModulo, (err: Error | null, ...retorno: any[]) => {
            if (err) {
                this._Logger.Warning("[ClienteSocket] Sem resposta do Core em", this.opcoes.timeoutMs + "ms. evento:", evento, "destino:", destino);
                callback({ status: "Erro", mensagem: "Tempo esgotado aguardando resposta de " + destino });
                return;
            }
            callback(...retorno);
        });
    }


    /**
     * Lista os módulos registrados no Core (evento `core/modulos/listar`, resposta { status, dados: [{ Modulo_ID, Modulo_Nome }] }).
     * Usado para descobrir QUEM é o módulo de origem de um pacote (o campo `origem` traz só o Modulo_ID).
     */
    ListarModulos(): Promise<Array<{ Modulo_ID: string; Modulo_Nome: string }>> {
        return new Promise((resolve, reject) => {
            if (!this.Registrado) {
                reject(new Error("Core indisponível no momento"));
                return;
            }
            this.socketClient.timeout(this.opcoes.timeoutMs).emit("core/modulos/listar", {}, (err: Error | null, resposta: any) => {
                if (err || !resposta || !Array.isArray(resposta.dados)) {
                    reject(new Error("Não foi possível listar os módulos do Core"));
                    return;
                }
                resolve(resposta.dados);
            });
        });
    }


    private Endereco(): string {
        return this.opcoes.host + ":" + this.opcoes.porta;
    }
}
