import { Socket_Client } from "../Modulos/Socket_Client";

// Mesmo formato já usado pelo WS-Mod_TurboGrowth (Controllers/TurboGrowth/Tipos.ts), para não
// cada módulo inventar o seu. Ver WS-Core_Autenticador/TAREFA_AUTORIZACAO_ESCOPO_DADOS.md.
export type Escopo = "global" | "equipe" | "individual";
export interface ContextoUsuario {
  usuarioId: number;
  escopo: Escopo;
  equipeIds: number[];
  permissoes: string[];
}

interface RespostaAutorizar {
  status?: "OK" | "Erro";
  mensagem?: string;
  // Campo `dados` só existe depois que a TAREFA_AUTORIZACAO_ESCOPO_DADOS.md for implementada.
  // Até lá, vem undefined e caímos no padrão restritivo abaixo (nunca em admin/global).
  dados?: { usuarioId?: number; escopo?: Escopo; equipeIds?: number[]; permissoes?: string[] };
}

type Emitir = (evento: string, destino: string, token: string, dados: Object, callback?: (...retorno: any[]) => void) => void;

const DESTINO_AUTENTICADOR = "WSCore_Autenticador/*";
// Resultados reaproveitados por alguns segundos: uma tela dispara vários eventos seguidos.
// Inativar usuário/perfil ou encerrar sessão vale no máximo após esse tempo.
const VALIDADE_CACHE_MS = 30_000;

/**
 * Ponte com o WS-Core_Autenticador para autorização. Fail-closed: qualquer resposta que não
 * seja OK rejeita a chamada — nunca existe um contexto padrão de administrador.
 *
 * - `usuarios/logintoken` valida a sessão (usuário ativo, token não vencido) e devolve o id;
 *   antes o id era lido direto da tabela _Usuarios pelo token (acoplamento ao Autenticador).
 * - `usuarios/autorizar` confere a permissão (perfil ativo; [system]/adm vale para tudo).
 */
export class Autenticador_Cliente {
  private readonly emitir: Emitir;
  private readonly cacheToken = new Map<string, { usuarioId: number; expira: number }>();
  private readonly cachePermissao = new Map<string, { permitido: boolean; expira: number }>();

  public constructor(core: Socket_Client | { emit: Emitir }) {
    this.emitir = core.emit.bind(core) as Emitir;
  }

  private chamar(evento: string, token: string, dados: Object): Promise<any> {
    return new Promise((resolve) => this.emitir(evento, DESTINO_AUTENTICADOR, token, dados, (r: unknown) => resolve(r)));
  }

  private limparVencidos(agora: number): void {
    if (this.cacheToken.size + this.cachePermissao.size < 5000) return;
    for (const [chave, item] of this.cacheToken) if (item.expira <= agora) this.cacheToken.delete(chave);
    for (const [chave, item] of this.cachePermissao) if (item.expira <= agora) this.cachePermissao.delete(chave);
  }

  private async usuarioDoToken(token: string): Promise<number> {
    const agora = Date.now();
    const emCache = this.cacheToken.get(token);
    if (emCache && emCache.expira > agora) return emCache.usuarioId;
    const resposta = await this.chamar("usuarios/logintoken", token, {});
    if (resposta?.login !== "OK" || typeof resposta.id !== "number") {
      this.cacheToken.delete(token);
      throw new Error(resposta?.status === "Erro" && resposta?.login === undefined ? "Autenticador indisponível no momento" : "Token inválido ou expirado");
    }
    this.limparVencidos(agora);
    this.cacheToken.set(token, { usuarioId: resposta.id, expira: agora + VALIDADE_CACHE_MS });
    return resposta.id;
  }

  private async permitido(token: string, permissao: string): Promise<RespostaAutorizar> {
    const chave = `${token}|${permissao}`;
    const agora = Date.now();
    const emCache = this.cachePermissao.get(chave);
    if (emCache && emCache.expira > agora) return emCache.permitido ? { status: "OK" } : { status: "Erro", mensagem: "Sem permissão" };
    const resposta: RespostaAutorizar = await this.chamar("usuarios/autorizar", token, { permissao });
    // Falha de comunicação (Core/Autenticador fora) não fica em cache
    if (resposta?.status === "OK" || resposta?.mensagem === "Sem permissão") {
      this.cachePermissao.set(chave, { permitido: resposta.status === "OK", expira: agora + VALIDADE_CACHE_MS });
    }
    return resposta;
  }

  public async Autorizar(token: string, permissao: string): Promise<ContextoUsuario> {
    if (!token) throw new Error("Token ausente");
    const usuarioId = await this.usuarioDoToken(token);
    const resposta = await this.permitido(token, permissao);
    if (resposta?.status !== "OK") throw new Error(resposta?.mensagem ?? "Sem permissão");

    return {
      usuarioId,
      // Sem a extensão de escopo, o padrão é o mais restritivo ("individual"), nunca "global".
      escopo: resposta.dados?.escopo ?? "individual",
      equipeIds: resposta.dados?.equipeIds ?? [],
      // Sem a extensão, só garantimos a permissão que acabou de ser verificada — nada de
      // conceder um conjunto amplo de permissões que não foi checado.
      permissoes: resposta.dados?.permissoes ?? [permissao],
    };
  }
}
