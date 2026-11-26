import { Erro_Email, Mensagem_Pronta } from "../../Models/Email/Tipos";
import { Modelo_Configuracao } from "../../Models/Modelo_Configuracao";
import { Conector_Mysql } from "../Lib/Conector_Mysql";
import { Logger } from "../Lib/Logger";
import { Descrever_Erro } from "../Lib/Erros";
import { Solicitante } from "./Autorizacao_Email";
import { Html_Para_Texto } from "./Formatacao_Email";
import { Servico_Controle } from "./Controle_Email";
import { Limitador_Taxa } from "./Limitador_Taxa";
import { Relogio } from "./Relogio_Email";
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
    private readonly controle: Servico_Controle,
    private readonly relogio: Relogio = new Relogio(),
  ) {
    this.segredos = [config.SMTP.Senha, config.SMTP.Usuario, config.Core.Segredo, config.BD.Senha];
  }

  // Fila de um só lugar: "conferir limite + reservar (INSERT 'enviando')" não pode intercalar entre dois pedidos,
  // senão dois envios simultâneos passariam juntos pelo mesmo saldo. (Uma instância do módulo por banco.)
  private fila: Promise<unknown> = Promise.resolve();

  private Exclusivo<T>(tarefa: () => Promise<T>): Promise<T> {
    const resultado = this.fila.then(tarefa, tarefa);
    this.fila = resultado.catch(() => undefined);
    return resultado;
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

    // Pausa e limites diário/mensal (código pausado/limite_diario/limite_mensal) e, em seguida, o registro ANTES
    // de enviar: se o processo cair no meio, fica rastro; sem conseguir registrar, não envia. O registro
    // "enviando" já reserva a cota dos destinatários (ver Uso_Email.ts), por isso os dois passos andam juntos.
    const id = await this.Exclusivo(async () => {
      try {
        await this.controle.Verificar_Envio(total);
      } catch (erro) {
        if (erro instanceof Erro_Email) {
          this.logger.Warning(`[Email] Envio recusado (${erro.codigo}) módulo=${solicitante.modulo} destinatários=${total}`);
          throw erro;
        }
        this.logger.Error("[Email] Não foi possível conferir limites/pausa; nada foi enviado:", Descrever_Erro(erro, this.segredos));
        throw new Erro_Email("interno", "Não foi possível conferir os limites de envio; o e-mail não foi enviado");
      }
      try {
        const r = await this.bd.Executar(
          `INSERT INTO _Core_Email_Envios (criado_em, solicitante_modulo, usuario_id, referencia, para, cc, bcc, assunto, template, qtd_anexos, tamanho_bytes, transporte, qtd_destinatarios, qtd_aceitos, status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0, 'enviando')`,
          [this.relogio.Agora(), solicitante.modulo, solicitante.usuarioId, pedido.referencia ?? null, pedido.para.join(", "),
            pedido.cc.length ? pedido.cc.join(", ") : null, pedido.bcc.length ? pedido.bcc.join(", ") : null,
            assunto.slice(0, 255), pedido.template ?? null, pedido.anexos.length, bytes, this.transporte.Nome, total],
        );
        return Number(r.insertId);
      } catch (erro) {
        this.logger.Error("[Email] Não foi possível registrar o envio; nada foi enviado:", Descrever_Erro(erro, this.segredos));
        throw new Erro_Email("interno", "Não foi possível registrar o envio no banco de dados; o e-mail não foi enviado");
      }
    });

    try {
      const resultado = await this.transporte.Enviar(mensagem);
      await this.Concluir(id, "enviado", { messageId: resultado.messageId, aceitos: resultado.aceitos.length });
      this.logger.Info(`[Email] Enviado #${id} (${this.transporte.Nome}) módulo=${solicitante.modulo} destinatários=${total}${pedido.template ? " template=" + pedido.template : ""}`);
      return { id, messageId: resultado.messageId, destinatarios: total, aceitos: resultado.aceitos.length, recusados: resultado.recusados.length, transporte: this.transporte.Nome };
    } catch (erro) {
      const mapeado = Mapear_Erro_Envio(erro);
      await this.Concluir(id, "falhou", { codigo: mapeado.codigo, erro: Descrever_Erro_Envio(erro, this.segredos) });
      this.logger.Warning(`[Email] Falha no envio #${id} módulo=${solicitante.modulo}: ${mapeado.codigo} - ${Descrever_Erro(erro, this.segredos)}`);
      throw mapeado;
    }
  }

  private async Concluir(id: number, status: "enviado" | "falhou", dados: { messageId?: string; aceitos?: number; codigo?: string; erro?: string }): Promise<void> {
    try {
      await this.bd.Executar(
        "UPDATE _Core_Email_Envios SET status = ?, message_id = ?, erro_codigo = ?, erro = ?, qtd_aceitos = ?, concluido_em = ? WHERE id = ?",
        [status, dados.messageId?.slice(0, 255) ?? null, dados.codigo ?? null, dados.erro ?? null, dados.aceitos ?? 0, this.relogio.Agora(), id],
      );
    } catch (erro) {
      // O e-mail já foi (ou não) enviado; falha ao atualizar o log não muda o resultado
      this.logger.Error(`[Email] Não foi possível atualizar o registro #${id}:`, Descrever_Erro(erro, this.segredos));
    }
  }
}
