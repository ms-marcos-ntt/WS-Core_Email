import { Socket_Client } from "../Modulos/Socket_Client";
import { Pacotes_Socket } from "../../Models/Modulos/Pacotes_Socket";
import { Erro_Email } from "../../Models/Email/Tipos";
import { Modelo_Configuracao } from "../../Models/Modelo_Configuracao";
import { Erro_Para_Tela } from "../Lib/Erros";
import { Servico_Controle } from "./Controle_Email";
import { Historico_Email } from "./Historico_Email";
import { Problemas_Config_SMTP } from "./Transporte_Email";
import { Relogio } from "./Relogio_Email";
import { Calcular_Medidor, Consultar_Consumo, Consultar_Periodo, Montar_Avisos } from "./Uso_Email";
import { Conector_Mysql } from "../Lib/Conector_Mysql";

type Callback = (resposta: Record<string, unknown>) => void;

export const PERMISSAO_VISUALIZAR = "email.visualizar";
export const PERMISSAO_ADMINISTRAR = "email.administrar";

interface Autorizador_Usuario { Autorizar(token: string, permissao: string): Promise<{ usuarioId: number }> }

/** Mensagens do Autenticador que podem ir para a tela como estão (qualquer outra vira "Sem permissão"). */
const MENSAGENS_AUTH_SEGURAS = new Set(["Token ausente", "Token inválido ou expirado", "Sem permissão", "Autenticador indisponível no momento"]);

function Ler_Dados(pacote: Pacotes_Socket): unknown {
  const bruto = pacote?.dados;
  if (bruto === undefined || bruto === null || bruto === "") return {};
  if (typeof bruto !== "string") return bruto;
  try { return JSON.parse(bruto); } catch { throw new Erro_Email("validacao", "Pacote inválido: os dados não são um JSON válido"); }
}

/**
 * Eventos da tela (histórico, uso e controle). São chamados pelo NAVEGADOR via WebServer, então —
 * ao contrário de `email/enviar`, que só aceita módulos de `Autorizacao.ModulosPermitidos` — aqui
 * quem manda é o usuário: todo evento valida o token e a permissão no Autenticador (fail-closed:
 * qualquer resposta que não seja OK recusa) antes de tocar no banco.
 *
 *   email/historico/listar   email.visualizar     email/historico/obter   email.visualizar
 *   email/historico/opcoes   email.visualizar     email/uso/resumo        email.visualizar
 *   email/controle/salvar    email.administrar
 */
export class Socket_Email_Tela {
  public constructor(
    private readonly core: Pick<Socket_Client, "Escutar">,
    private readonly config: Modelo_Configuracao,
    private readonly bd: Pick<Conector_Mysql, "Query">,
    private readonly historico: Historico_Email,
    private readonly controle: Servico_Controle,
    private readonly autenticador: Autorizador_Usuario,
    private readonly relogio: Relogio,
    private readonly segredos: Array<string | undefined> = [],
  ) {}

  private async Autorizar(pacote: Pacotes_Socket, permissao: string): Promise<number> {
    try {
      return (await this.autenticador.Autorizar(typeof pacote?.token === "string" ? pacote.token : "", permissao)).usuarioId;
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : "";
      throw new Erro_Email("nao_autorizado", MENSAGENS_AUTH_SEGURAS.has(mensagem) ? mensagem : "Sem permissão");
    }
  }

  private Erro(evento: string, erro: unknown): Record<string, unknown> {
    return { status: "Erro", mensagem: Erro_Para_Tela(evento, erro, this.segredos), codigo: erro instanceof Erro_Email ? erro.codigo : "interno" };
  }

  private Registrar_Evento(evento: string, permissao: string, tratar: (usuarioId: number, dados: unknown, pacote: Pacotes_Socket) => Promise<unknown>): void {
    this.core.Escutar(evento, async (pacote: Pacotes_Socket, callback: Callback) => {
      try {
        const usuarioId = await this.Autorizar(pacote, permissao);
        callback({ status: "OK", dados: await tratar(usuarioId, Ler_Dados(pacote), pacote) });
      } catch (erro) {
        callback(this.Erro(evento, erro));
      }
    });
  }

  public Registrar(): void {
    this.Registrar_Evento("email/historico/listar", PERMISSAO_VISUALIZAR, (_u, dados) => this.historico.Listar(dados));
    this.Registrar_Evento("email/historico/obter", PERMISSAO_VISUALIZAR, (_u, dados) => this.historico.Obter(dados));
    this.Registrar_Evento("email/historico/opcoes", PERMISSAO_VISUALIZAR, () => this.historico.Opcoes());
    this.Registrar_Evento("email/uso/resumo", PERMISSAO_VISUALIZAR, (_u, dados, pacote) => this.Resumo(dados, pacote));
    this.Registrar_Evento("email/controle/salvar", PERMISSAO_ADMINISTRAR, async (usuarioId, dados) => {
      const r = await this.controle.Alterar(usuarioId, dados);
      return { controle: r.controle, alterados: r.alterados };
    });
  }

  /** Painel de uso e limites. `periodo`: 7 (padrão) ou 30 dias para série, quebras e taxa de falha. */
  public async Resumo(dados: unknown, pacote: Pacotes_Socket): Promise<Record<string, unknown>> {
    const pedido = (dados ?? {}) as { periodo?: unknown };
    if (pedido.periodo !== undefined && pedido.periodo !== 7 && pedido.periodo !== 30) throw new Erro_Email("validacao", 'Campo "periodo" deve ser 7 ou 30');
    const dias: 7 | 30 = pedido.periodo === 30 ? 30 : 7;

    // Quem só visualiza não vê os controles; a checagem do servidor em email/controle/salvar é a que vale.
    const podeAdministrar = await this.Autorizar(pacote, PERMISSAO_ADMINISTRAR).then(() => true, () => false);

    const [controle, consumo, periodo, historicoControle] = await Promise.all([
      this.controle.Obter(), Consultar_Consumo(this.bd, this.relogio), Consultar_Periodo(this.bd, this.relogio, dias), this.controle.Historico(10),
    ]);
    const diario = Calcular_Medidor(consumo.hoje, controle.limiteDiario, controle.percentualAlerta);
    const mensal = Calcular_Medidor(consumo.mes, controle.limiteMensal, controle.percentualAlerta);
    const cfg = this.config;
    return {
      geradoEm: this.relogio.Agora(), fuso: "America/Sao_Paulo", periodo: dias, unidade: "destinatários aceitos",
      consumo, diario, mensal, controle,
      avisos: Montar_Avisos(diario, mensal, controle.pausado, controle.percentualAlerta),
      ...periodo, historicoControle, podeAdministrar,
      // Somente leitura (config.cfg): nada de credenciais, host ou remetente.
      configCfg: {
        rateLimit: cfg.RateLimit, limites: cfg.Email.Limites,
        smtp: { modo: cfg.SMTP.Modo, configurado: cfg.SMTP.Modo === "simulado" || Problemas_Config_SMTP(cfg.SMTP).length === 0 },
        modulosPermitidos: cfg.Autorizacao.ModulosPermitidos, exigirPermissaoUsuario: cfg.Autorizacao.ExigirPermissaoUsuario,
      },
    };
  }
}
