import { Socket } from "socket.io-client";

export class Modulos_Struct {
  public Modulo_ID = "";
  public Modulo_Nome = "WSCore_Email";
  public Modulo_Descricao = "Envio de e-mail (SMTP/AWS SES) compartilhado entre os módulos";
  public Modulo_Versao = "0.1.0";
  public Socket?: Socket;

  public toJson(): Record<string, string> {
    return { Modulo_ID: this.Modulo_ID, Modulo_Nome: this.Modulo_Nome, Modulo_Descricao: this.Modulo_Descricao, Modulo_Versao: this.Modulo_Versao };
  }
}
