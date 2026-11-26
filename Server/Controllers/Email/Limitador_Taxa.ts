import { Erro_Email } from "../../Models/Email/Tipos";

/**
 * Rate limit simples em memória, por janela deslizante: no máximo `maximoPorChave` envios por
 * módulo e `maximoGlobal` no total, a cada `janelaMs`. Protege contra loop em um módulo que
 * dispararia centenas de e-mails (e contra estourar a cota do SES). Reinicia junto com o processo.
 */
export class Limitador_Taxa {
  private readonly porChave = new Map<string, number[]>();
  private global: number[] = [];

  public constructor(
    private readonly janelaMs: number,
    private readonly maximoPorChave: number,
    private readonly maximoGlobal: number,
    private readonly agora: () => number = Date.now,
  ) {}

  private Podar(lista: number[], limite: number): number[] {
    let i = 0;
    while (i < lista.length && lista[i] <= limite) i++;
    return i === 0 ? lista : lista.slice(i);
  }

  /** Registra um envio da chave ou lança Erro_Email("limite_excedido"). */
  public Consumir(chave: string): void {
    const t = this.agora();
    const limite = t - this.janelaMs;
    this.global = this.Podar(this.global, limite);
    const doModulo = this.Podar(this.porChave.get(chave) ?? [], limite);

    if (doModulo.length >= this.maximoPorChave) {
      this.porChave.set(chave, doModulo);
      throw new Erro_Email("limite_excedido", `Limite de envios excedido para este módulo (${this.maximoPorChave} a cada ${Math.round(this.janelaMs / 1000)}s). Tente novamente em instantes`);
    }
    if (this.global.length >= this.maximoGlobal) {
      this.porChave.set(chave, doModulo);
      throw new Erro_Email("limite_excedido", `Limite global de envios excedido (${this.maximoGlobal} a cada ${Math.round(this.janelaMs / 1000)}s). Tente novamente em instantes`);
    }
    doModulo.push(t);
    this.global.push(t);
    this.porChave.set(chave, doModulo);

    // Chaves antigas não ficam acumulando
    if (this.porChave.size > 200) {
      for (const [k, lista] of this.porChave) if (this.Podar(lista, limite).length === 0) this.porChave.delete(k);
    }
  }
}
