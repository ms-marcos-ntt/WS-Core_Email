import { Erro_Email, Mensagem_Pronta } from "../../Models/Email/Tipos";
import { Modelo_Configuracao } from "../../Models/Modelo_Configuracao";
import { Conector_Mysql } from "../Lib/Conector_Mysql";
import { Logger } from "../Lib/Logger";
import { Descrever_Erro } from "../Lib/Erros";
import { Solicitante } from "./Autorizacao_Email";
import { Html_Para_Texto } from "./Formatacao_Email";
import { Limitador_Taxa } from "./Limitador_Taxa";
import { Templates_Email } from "./Templates_Email";
import { Descrever_Erro_Envio, Mapear_Erro_Envio, Transporte_Email } from "./Transporte_Email";
import { Validar_Pedido } from "./Validacao_Email";

export interface Resposta_Envio {
  /** Id do registro em _Core_Email_Envios. */
  id: number;
  /** Message-ID atribuído pelo servidor SMTP (rastreio no SES). */
  messageId: string;
  destinatarios: number;
  aceitos: number;
  recusados: number;
  transporte: "smtp" | "simulado";
}

type Banco = Pick<Conector_Mysql, "Executar" | "Query">;

/**
 * Serviço de envio: valida, aplica template, respeita rate limit, grava o log em
 * `_Core_Email_Envios` (antes e depois do envio) e entrega ao transporte.
 */
export class Config_Email {
  private readonly logger = new Logger();
  private readonly segredos: Array<string | undefined>;

  public constructor(
    private readonly config: Modelo_Configuracao,
    private readonly bd: Banco,
    private readonly transporte: Transporte_Email,
    private readonly templates: Templates_Email,
    private readonly limitador: Limitador_Taxa,
  ) {
    this.segredos = [config.SMTP.Senha, config.SMTP.Usuario, config.Core.Segredo, config.BD.Senha];
  }

  public async Ping(): Promise<Record<string, unknown>> {
    await this.bd.Query("SELECT 1");
    let configurado = true;
    try { this.transporte.Verificar(); } catch { configurado = false; }
    return { modulo: this.config.modulo.nome, versao: this.config.modulo.versao, transporte: this.transporte.Nome, configurado };
  }

  public ListarTemplates(): string[] {
    return this.templates.Listar();
  }

  public async Enviar(solicitante: Solicitante, dadosBrutos: unknown): Promise<Resposta_Envio> {
    const limites = this.config.Email.Limites;
    // Rate limit antes de qualquer trabalho (decodificar anexos, ler templates)
    this.limitador.Consumir(solicitante.modulo);

    const pedido = Validar_Pedido(dadosBrutos, limites);

    let assunto: string;
    let texto: string | undefined;
    let html: string | undefined;
    if (pedido.template !== undefined) {
      const r = this.templates.Renderizar(pedido.template, pedido.variaveis, limites.MaxAssunto);
      ({ assunto, texto, html } = r);
    } else {
      assunto = pedido.assunto as string;
      texto = pedido.texto?.trim() ? pedido.texto : undefined;
      html = pedido.html?.trim() ? pedido.html : undefined;
      if (texto === undefined && html !== undefined) texto = Html_Para_Texto(html);
    }

    const mensagem: Mensagem_Pronta = {
      de: this.config.SMTP.Remetente,
      para: pedido.para, cc: pedido.cc, bcc: pedido.bcc,
      responderPara: pedido.responderPara,
      assunto, texto, html,
      anexos: pedido.anexos,
    };
    const total = pedido.para.length + pedido.cc.length + pedido.bcc.length;
    const bytes = (texto?.length ?? 0) + (html?.length ?? 0) + pedido.anexos.reduce((s, a) => s + a.conteudo.length, 0);

    // Registro ANTES de enviar: se o processo cair no meio, fica rastro; sem conseguir registrar, não envia
    let id: number;
    try {
      const r = await this.bd.Executar(
        `INSERT INTO _Core_Email_Envios (solicitante_modulo, usuario_id, referencia, para, cc, bcc, assunto, template, qtd_anexos, tamanho_bytes, transporte, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, 'enviando')`,
        [solicitante.modulo, solicitante.usuarioId, pedido.referencia ?? null, pedido.para.join(", "),
          pedido.cc.length ? pedido.cc.join(", ") : null, pedido.bcc.length ? pedido.bcc.join(", ") : null,
          assunto.slice(0, 255), pedido.template ?? null, pedido.anexos.length, bytes, this.transporte.Nome],
      );
      id = Number(r.insertId);
    } catch (erro) {
      this.logger.Error("[Email] Não foi possível registrar o envio; nada foi enviado:", Descrever_Erro(erro, this.segredos));
      throw new Erro_Email("interno", "Não foi possível registrar o envio no banco de dados; o e-mail não foi enviado");
    }

    try {
      const resultado = await this.transporte.Enviar(mensagem);
      await this.Concluir(id, "enviado", { messageId: resultado.messageId });
      this.logger.Info(`[Email] Enviado #${id} (${this.transporte.Nome}) módulo=${solicitante.modulo} destinatários=${total}${pedido.template ? " template=" + pedido.template : ""}`);
      return { id, messageId: resultado.messageId, destinatarios: total, aceitos: resultado.aceitos.length, recusados: resultado.recusados.length, transporte: this.transporte.Nome };
    } catch (erro) {
      const mapeado = Mapear_Erro_Envio(erro);
      await this.Concluir(id, "falhou", { codigo: mapeado.codigo, erro: Descrever_Erro_Envio(erro, this.segredos) });
      this.logger.Warning(`[Email] Falha no envio #${id} módulo=${solicitante.modulo}: ${mapeado.codigo} - ${Descrever_Erro(erro, this.segredos)}`);
      throw mapeado;
    }
  }

  private async Concluir(id: number, status: "enviado" | "falhou", dados: { messageId?: string; codigo?: string; erro?: string }): Promise<void> {
    try {
      await this.bd.Executar(
        "UPDATE _Core_Email_Envios SET status = ?, message_id = ?, erro_codigo = ?, erro = ?, concluido_em = CURRENT_TIMESTAMP(3) WHERE id = ?",
        [status, dados.messageId?.slice(0, 255) ?? null, dados.codigo ?? null, dados.erro ?? null, id],
      );
    } catch (erro) {
      // O e-mail já foi (ou não) enviado; falha ao atualizar o log não muda o resultado
      this.logger.Error(`[Email] Não foi possível atualizar o registro #${id}:`, Descrever_Erro(erro, this.segredos));
    }
  }
}
