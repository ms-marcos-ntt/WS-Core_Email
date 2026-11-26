import { Erro_Email } from "../../Models/Email/Tipos";
import { Modelo_Configuracao } from "../../Models/Modelo_Configuracao";
import { Logger } from "../Lib/Logger";

/**
 * Autorização de quem pede o envio.
 *
 * Por que não basta "veio pelo Core": o WebServer repassa ao Core qualquer evento/destino que o
 * navegador de um usuário logado emitir (com o token dele). Sem controle, qualquer usuário
 * poderia mandar `email/enviar` e usar o remetente da empresa. Por isso:
 *
 *  1. O pacote traz `origem` = Modulo_ID de quem o enviou ao Core. O módulo resolve o ID para o
 *     nome do módulo (`core/modulos/listar`) e só aceita nomes de `Autorizacao.ModulosPermitidos`.
 *     O WebServer NÃO deve estar nessa lista. Lista vazia = ninguém envia.
 *  2. Opcional (`ExigirPermissaoUsuario`): além disso, o pacote precisa trazer o token de um usuário
 *     com a permissão `email.enviar` no Autenticador. Por padrão fica desligado: os módulos
 *     permitidos já são infraestrutura confiável (passaram pelo Core.SegredoModulos) e cada um
 *     checa a permissão do usuário no próprio domínio (ex.: `fibramap.*`) antes de pedir o e-mail.
 *
 * Limite conhecido: o Core não sobrescreve `origem`; um módulo registrado poderia informar o
 * Modulo_ID de outro. Todos os módulos registrados já são de confiança (segredo compartilhado).
 */

/** Descobre o nome do módulo a partir do Modulo_ID. */
export interface Resolvedor_Modulos {
  NomeDoModulo(id: string): Promise<string | undefined>;
}

/** Resolve via Core (`core/modulos/listar`), com cache curto. */
export class Resolvedor_Modulos_Core implements Resolvedor_Modulos {
  private cache = new Map<string, string>();
  private atualizadoEm = 0;

  public constructor(
    private readonly core: { ListarModulos(): Promise<Array<{ Modulo_ID: string; Modulo_Nome: string }>> },
    private readonly validadeMs = 15_000,
    private readonly intervaloMinimoMs = 2_000,
    private readonly agora: () => number = Date.now,
  ) {}

  public async NomeDoModulo(id: string): Promise<string | undefined> {
    const t = this.agora();
    const emCache = this.cache.get(id);
    if (emCache !== undefined && t - this.atualizadoEm < this.validadeMs) return emCache;
    // ID desconhecido ou cache velho: atualiza, mas no máximo a cada `intervaloMinimoMs`
    // (um ID inventado não pode virar uma consulta ao Core por pacote)
    if (t - this.atualizadoEm >= this.intervaloMinimoMs) {
      const lista = await this.core.ListarModulos();
      this.cache = new Map(lista.filter((m) => typeof m.Modulo_ID === "string" && typeof m.Modulo_Nome === "string").map((m) => [m.Modulo_ID, m.Modulo_Nome]));
      this.atualizadoEm = t;
    }
    return this.cache.get(id);
  }
}

export interface Solicitante { modulo: string; usuarioId: number | null }

interface Autorizador_Usuario { Autorizar(token: string, permissao: string): Promise<{ usuarioId: number }> }

export class Autorizacao_Email {
  private readonly logger = new Logger();

  public constructor(
    private readonly config: Modelo_Configuracao["Autorizacao"],
    private readonly resolvedor: Resolvedor_Modulos,
    private readonly autenticador?: Autorizador_Usuario,
  ) {}

  /** Identifica e autoriza o solicitante do pacote. Lança Erro_Email("nao_autorizado"). */
  public async Autorizar(pacote: { origem?: unknown; token?: unknown }): Promise<Solicitante> {
    const origem = typeof pacote?.origem === "string" ? pacote.origem.trim() : "";
    if (origem === "" || origem.length > 100) {
      this.logger.Warning("[Email] Pedido recusado: pacote sem módulo de origem");
      throw new Erro_Email("nao_autorizado", "Módulo de origem não identificado");
    }

    let modulo: string | undefined;
    try {
      modulo = await this.resolvedor.NomeDoModulo(origem);
    } catch {
      throw new Erro_Email("nao_autorizado", "Não foi possível identificar o módulo de origem (Core indisponível)");
    }
    if (modulo === undefined || !this.config.ModulosPermitidos.includes(modulo)) {
      this.logger.Warning("[Email] Pedido recusado: módulo de origem não autorizado:", modulo ?? "(desconhecido)");
      throw new Erro_Email("nao_autorizado", "Módulo de origem não autorizado a enviar e-mails");
    }

    let usuarioId: number | null = null;
    if (this.config.ExigirPermissaoUsuario) {
      const token = typeof pacote.token === "string" ? pacote.token : "";
      if (!this.autenticador) throw new Erro_Email("nao_autorizado", "Verificação de permissão do usuário indisponível");
      try {
        usuarioId = (await this.autenticador.Autorizar(token, this.config.PermissaoEnvio)).usuarioId;
      } catch (erro) {
        const mensagem = erro instanceof Error ? erro.message : "";
        this.logger.Warning("[Email] Pedido recusado: usuário sem permissão ou sessão inválida. módulo:", modulo);
        throw new Erro_Email("nao_autorizado", mensagem === "Autenticador indisponível no momento" ? mensagem : "Usuário sem permissão para enviar e-mails ou sessão inválida");
      }
    }
    return { modulo, usuarioId };
  }
}
