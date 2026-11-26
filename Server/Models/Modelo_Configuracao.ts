export interface Limites_Email {
  /** Máximo de destinatários somando para + cc + bcc. */
  MaxDestinatarios: number;
  MaxAssunto: number;
  /** Tamanho máximo (caracteres) do corpo em texto. */
  MaxTexto: number;
  /** Tamanho máximo (caracteres) do corpo em HTML. */
  MaxHtml: number;
  MaxAnexos: number;
  /** Tamanho máximo de cada anexo, já decodificado (bytes). */
  MaxAnexoBytes: number;
  MaxTotalAnexosBytes: number;
}

export interface Modelo_Configuracao {
  BD: { Usuario: string; Senha: string; Database: string; Host: string; Porta: number };
  /** Conexão com o Core. Segredo = Core.SegredoModulos do WS-Core (vazio = não envia). */
  Core: { Host: string; Porta: number; Segredo: string; TimeoutMs: number };
  LOG: { Console: boolean; Arquivo: boolean; LocalArquivo: string; Rotatividade: number };
  /** Pasta (relativa à raiz do módulo) das telas servidas pelo evento `webfiles`. */
  WebFiles: { Pasta_Arquivos_Html: string };
  /**
   * Servidor de envio. Modo "smtp" envia de verdade (AWS SES: email-smtp.<região>.amazonaws.com,
   * 587 + Seguro=false [STARTTLS] ou 465 + Seguro=true). Modo "simulado" não envia nada, só registra
   * (desenvolvimento). Sem Host/Usuario/Senha/Remetente o modo "smtp" recusa os envios com erro claro.
   */
  SMTP: { Modo: "smtp" | "simulado"; Host: string; Porta: number; Seguro: boolean; Usuario: string; Senha: string; Remetente: string; TimeoutMs: number };
  Email: { PastaTemplates: string; Limites: Limites_Email };
  Autorizacao: {
    /** Nomes (Modulo_Nome) dos módulos que podem pedir envio. Lista vazia = ninguém (fail-closed). */
    ModulosPermitidos: string[];
    /** Se true, o pacote precisa trazer o token de um usuário com a permissão `PermissaoEnvio`. */
    ExigirPermissaoUsuario: boolean;
    PermissaoEnvio: string;
  };
  RateLimit: { JanelaSegundos: number; MaximoPorModulo: number; MaximoGlobal: number };
  modulo: { nome: string; versao: string };
}
