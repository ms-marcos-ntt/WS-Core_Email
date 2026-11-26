import * as nodemailer from "nodemailer";
import { Erro_Email, Mensagem_Pronta, Resultado_Envio } from "../../Models/Email/Tipos";
import { Modelo_Configuracao } from "../../Models/Modelo_Configuracao";
import { Normalizar_Endereco } from "./Validacao_Email";
import { Descrever_Erro } from "../Lib/Erros";

export type Config_SMTP = Modelo_Configuracao["SMTP"];

/** Quem de fato entrega a mensagem. Trocável: SMTP real em produção, simulado em testes/desenvolvimento. */
export interface Transporte_Email {
  readonly Nome: "smtp" | "simulado";
  /** Lança Erro_Email("nao_configurado") se o transporte não puder enviar (sem tentar conectar). */
  Verificar(): void;
  Enviar(mensagem: Mensagem_Pronta): Promise<Resultado_Envio>;
  Fechar(): void;
}


/** Aceita `a@b.com` ou `Nome <a@b.com>`. Devolve o remetente normalizado ou undefined se inválido. */
export function Validar_Remetente(remetente: string): string | undefined {
  const texto = remetente.trim();
  const m = /^([^<>\r\n"]{1,100}?)\s*<([^<>\s]+)>$/.exec(texto);
  const endereco = Normalizar_Endereco(m ? m[2] : texto);
  if (!endereco) return undefined;
  return m ? `"${m[1].trim()}" <${endereco}>` : endereco;
}


/**
 * Confere se o bloco SMTP está preenchido. Devolve a lista de problemas (vazia = ok), sempre
 * dizendo QUAL campo falta mas nunca o valor.
 */
export function Problemas_Config_SMTP(smtp: Config_SMTP): string[] {
  const problemas: string[] = [];
  if (!String(smtp.Host ?? "").trim()) problemas.push("SMTP.Host");
  if (!String(smtp.Usuario ?? "").trim()) problemas.push("SMTP.Usuario");
  if (!String(smtp.Senha ?? "")) problemas.push("SMTP.Senha");
  const porta = Number(smtp.Porta);
  if (!Number.isInteger(porta) || porta < 1 || porta > 65535) problemas.push("SMTP.Porta");
  if (!String(smtp.Remetente ?? "").trim()) problemas.push("SMTP.Remetente");
  else if (!Validar_Remetente(String(smtp.Remetente))) problemas.push("SMTP.Remetente (formato inválido: use nome@dominio.com ou Nome <nome@dominio.com>)");
  return problemas;
}


type CriarTransporte = (opcoes: nodemailer.TransportOptions | Record<string, unknown>) => nodemailer.Transporter;

/** Envio real por SMTP (AWS SES, etc.) via nodemailer. A conexão só é criada no primeiro envio. */
export class Transporte_SMTP implements Transporte_Email {
  public readonly Nome = "smtp" as const;
  private transporter?: nodemailer.Transporter;

  public constructor(private readonly smtp: Config_SMTP, private readonly criar: CriarTransporte = (o) => nodemailer.createTransport(o as nodemailer.TransportOptions)) {}

  public Verificar(): void {
    const problemas = Problemas_Config_SMTP(this.smtp);
    if (problemas.length > 0) {
      throw new Erro_Email("nao_configurado",
        `Envio de e-mail não configurado no WS-Core_Email: preencha ${problemas.join(", ")} no config.cfg (bloco SMTP) e reinicie o módulo`);
    }
  }

  private Obter(): nodemailer.Transporter {
    if (!this.transporter) {
      const timeout = Number(this.smtp.TimeoutMs) > 0 ? Number(this.smtp.TimeoutMs) : 20000;
      this.transporter = this.criar({
        host: this.smtp.Host.trim(),
        port: Number(this.smtp.Porta),
        secure: Boolean(this.smtp.Seguro),
        // Sem conexão direta TLS (465), exige STARTTLS: a senha nunca trafega em texto puro
        requireTLS: !this.smtp.Seguro,
        auth: { user: this.smtp.Usuario, pass: this.smtp.Senha },
        connectionTimeout: timeout,
        greetingTimeout: timeout,
        socketTimeout: timeout,
        // O conteúdo vem só de dados do pacote: nunca ler arquivo local nem baixar URL
        disableFileAccess: true,
        disableUrlAccess: true,
        tls: { minVersion: "TLSv1.2" },
      });
    }
    return this.transporter;
  }

  public async Enviar(mensagem: Mensagem_Pronta): Promise<Resultado_Envio> {
    this.Verificar();
    const info = await this.Obter().sendMail({
      from: Validar_Remetente(this.smtp.Remetente),
      to: mensagem.para,
      cc: mensagem.cc.length > 0 ? mensagem.cc : undefined,
      bcc: mensagem.bcc.length > 0 ? mensagem.bcc : undefined,
      replyTo: mensagem.responderPara,
      subject: mensagem.assunto,
      text: mensagem.texto,
      html: mensagem.html,
      attachments: mensagem.anexos.map((a) => ({ filename: a.nome, content: a.conteudo, contentType: a.tipo })),
    });
    const aceitos = (info.accepted ?? []).map(String);
    const recusados = (info.rejected ?? []).map(String);
    if (aceitos.length === 0) throw new Erro_Email("smtp_destinatario", "O servidor SMTP recusou todos os destinatários");
    return { messageId: String(info.messageId ?? ""), aceitos, recusados };
  }

  public Fechar(): void {
    this.transporter?.close();
    this.transporter = undefined;
  }
}


/**
 * Não envia nada: guarda as mensagens em memória (testes) e devolve sucesso.
 * Em `SMTP.Modo = "simulado"` serve para desenvolver sem credenciais.
 */
export class Transporte_Simulado implements Transporte_Email {
  public readonly Nome = "simulado" as const;
  public readonly Enviadas: Mensagem_Pronta[] = [];
  /** Se definido, o próximo envio falha com este erro (testes). */
  public FalharCom?: unknown;
  private contador = 0;

  public Verificar(): void { /* sempre pronto */ }

  public async Enviar(mensagem: Mensagem_Pronta): Promise<Resultado_Envio> {
    if (this.FalharCom !== undefined) {
      const erro = this.FalharCom;
      this.FalharCom = undefined;
      throw erro;
    }
    this.Enviadas.push(mensagem);
    if (this.Enviadas.length > 100) this.Enviadas.shift();
    this.contador++;
    const todos = [...mensagem.para, ...mensagem.cc, ...mensagem.bcc];
    return { messageId: `<simulado-${Date.now()}-${this.contador}@wscore-email>`, aceitos: todos, recusados: [] };
  }

  public Fechar(): void { /* nada a fechar */ }
}


export function Criar_Transporte(smtp: Config_SMTP): Transporte_Email {
  if (smtp.Modo === "simulado") return new Transporte_Simulado();
  if (smtp.Modo === "smtp" || smtp.Modo === undefined) return new Transporte_SMTP(smtp);
  throw new Erro_Email("nao_configurado", `SMTP.Modo inválido: use "smtp" ou "simulado"`);
}


interface Erro_Transporte { code?: unknown; responseCode?: unknown; command?: unknown }

/**
 * Converte um erro do nodemailer/rede em Erro_Email com mensagem segura (sem texto do servidor,
 * sem endereços, sem credenciais) e o código para o solicitante decidir o que fazer.
 */
export function Mapear_Erro_Envio(erro: unknown): Erro_Email {
  if (erro instanceof Erro_Email) return erro;
  const e = (typeof erro === "object" && erro !== null ? erro : {}) as Erro_Transporte;
  const code = String(e.code ?? "");
  const resposta = Number(e.responseCode);

  if (code === "EAUTH" || resposta === 535 || resposta === 534) {
    return new Erro_Email("smtp_autenticacao", "Falha de autenticação no servidor SMTP: confira SMTP.Usuario e SMTP.Senha");
  }
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || code === "ECONNECTIONTIMEOUT" || /timed? ?out/i.test((erro as Error | undefined)?.message ?? "")) {
    return new Erro_Email("smtp_timeout", "Tempo esgotado ao falar com o servidor SMTP");
  }
  if (["ECONNECTION", "ESOCKET", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EDNS", "EPROTOCOL", "ETLS", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) {
    return new Erro_Email("smtp_conexao", "Não foi possível conectar ao servidor SMTP (confira SMTP.Host, SMTP.Porta e SMTP.Seguro)");
  }
  if (code === "EENVELOPE") {
    return new Erro_Email("smtp_destinatario", "O servidor SMTP recusou o remetente ou os destinatários");
  }
  if (resposta >= 500 && resposta < 600) {
    return new Erro_Email("smtp_erro", `O servidor SMTP recusou a mensagem (código ${resposta}). No AWS SES, confira se o remetente/domínio está verificado e se a conta saiu do modo sandbox`);
  }
  return new Erro_Email("smtp_erro", "Falha ao enviar o e-mail pelo servidor SMTP");
}


/** Descrição técnica do erro para a tabela de envios (sem segredos nem dados pessoais). */
export function Descrever_Erro_Envio(erro: unknown, segredos: Array<string | undefined>): string {
  const e = (typeof erro === "object" && erro !== null ? erro : {}) as Erro_Transporte;
  const detalhes = [e.code ? `code=${String(e.code)}` : "", e.responseCode ? `smtp=${String(e.responseCode)}` : "", e.command ? `cmd=${String(e.command)}` : ""].filter(Boolean).join(" ");
  return `${detalhes ? detalhes + " | " : ""}${Descrever_Erro(erro, segredos)}`.slice(0, 1000);
}
