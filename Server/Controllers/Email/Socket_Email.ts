import { Socket_Client } from "../Modulos/Socket_Client";
import { Pacotes_Socket } from "../../Models/Modulos/Pacotes_Socket";
import { Erro_Email } from "../../Models/Email/Tipos";
import { Erro_Para_Tela } from "../Lib/Erros";
import { Autorizacao_Email } from "./Autorizacao_Email";
import { Config_Email } from "./Config_Email";

type Callback = (resposta: Record<string, unknown>) => void;

/** Registra os eventos do módulo no Core. Toda resposta é { status: "OK", dados } ou { status: "Erro", mensagem, codigo }. */
export class Socket_Email {
  public constructor(
    private readonly core: Pick<Socket_Client, "Escutar">,
    private readonly config: Config_Email,
    private readonly autorizacao: Autorizacao_Email,
    private readonly segredos: Array<string | undefined> = [],
  ) {}

  private Erro(evento: string, erro: unknown): Record<string, unknown> {
    return {
      status: "Erro",
      mensagem: Erro_Para_Tela(evento, erro, this.segredos),
      codigo: erro instanceof Erro_Email ? erro.codigo : "interno",
    };
  }

  public Registrar(): void {
    // Público — health-check (mesmo padrão de `fibramap/ping` e `people/ping`). Não expõe segredos.
    this.core.Escutar("email/ping", async (_pacote: Pacotes_Socket, callback: Callback) => {
      try {
        callback({ status: "OK", dados: await this.config.Ping() });
      } catch (erro) {
        callback(this.Erro("email/ping", erro));
      }
    });

    // Restrito aos módulos permitidos (ver Autorizacao_Email.ts)
    this.core.Escutar("email/templates", async (pacote: Pacotes_Socket, callback: Callback) => {
      try {
        await this.autorizacao.Autorizar(pacote);
        callback({ status: "OK", dados: this.config.ListarTemplates() });
      } catch (erro) {
        callback(this.Erro("email/templates", erro));
      }
    });

    this.core.Escutar("email/enviar", async (pacote: Pacotes_Socket, callback: Callback) => {
      try {
        const solicitante = await this.autorizacao.Autorizar(pacote);
        callback({ status: "OK", dados: await this.config.Enviar(solicitante, pacote.dados) });
      } catch (erro) {
        callback(this.Erro("email/enviar", erro));
      }
    });
  }
}
