/** Códigos de erro devolvidos a quem pediu o envio (campo `codigo` da resposta). */
export type Codigo_Erro_Email =
  | "validacao"
  | "nao_autorizado"
  | "limite_excedido"
  | "limite_diario"
  | "limite_mensal"
  | "pausado"
  | "template_invalido"
  | "nao_configurado"
  | "smtp_autenticacao"
  | "smtp_conexao"
  | "smtp_timeout"
  | "smtp_destinatario"
  | "smtp_erro"
  | "interno";

/** Erro com mensagem segura para devolver ao módulo solicitante (sem dados do servidor SMTP). */
export class Erro_Email extends Error {
  public constructor(public readonly codigo: Codigo_Erro_Email, mensagem: string) {
    super(mensagem);
    this.name = "Erro_Email";
  }
}

/** Anexo como chega no pacote: conteúdo em base64. */
export interface Anexo_Pedido {
  nome: string;
  conteudoBase64: string;
  tipo?: string;
}

/** Corpo do pacote `email/enviar` (campo `dados`, JSON). */
export interface Pedido_Email {
  para: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  assunto?: string;
  texto?: string;
  html?: string;
  template?: string;
  variaveis?: Record<string, string | number | boolean>;
  anexos?: Anexo_Pedido[];
  responderPara?: string;
  /** Texto livre do solicitante para rastrear o envio (ex.: "fibramap:pre_viabilidade:123"). */
  referencia?: string;
}

export interface Anexo_Validado { nome: string; conteudo: Buffer; tipo?: string }

/** Pedido já validado e normalizado (e-mails em minúsculas, sem duplicados), antes de aplicar template. */
export interface Pedido_Validado {
  para: string[];
  cc: string[];
  bcc: string[];
  assunto?: string;
  texto?: string;
  html?: string;
  template?: string;
  variaveis: Record<string, string>;
  anexos: Anexo_Validado[];
  responderPara?: string;
  referencia?: string;
}

/** Mensagem final entregue ao transporte. */
export interface Mensagem_Pronta {
  de: string;
  para: string[];
  cc: string[];
  bcc: string[];
  responderPara?: string;
  assunto: string;
  texto?: string;
  html?: string;
  anexos: Anexo_Validado[];
}

export interface Resultado_Envio {
  messageId: string;
  aceitos: string[];
  recusados: string[];
}
