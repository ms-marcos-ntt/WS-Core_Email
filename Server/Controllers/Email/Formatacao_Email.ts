/** Escapa texto para inserir dentro de HTML. */
export function Escapar_Html(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,49})\s*\}\}/g;

/** Nomes das variáveis `{{nome}}` usadas em um texto. */
export function Variaveis_Usadas(texto: string): string[] {
  return Array.from(texto.matchAll(PLACEHOLDER), (m) => m[1]);
}

/** Troca `{{nome}}` pelo valor; com `escapar` o valor é escapado para HTML. Variável ausente fica vazia (checar antes). */
export function Substituir_Variaveis(texto: string, variaveis: Record<string, string>, escapar: boolean): string {
  return texto.replace(PLACEHOLDER, (_inteiro, nome: string) => {
    const valor = Object.prototype.hasOwnProperty.call(variaveis, nome) ? variaveis[nome] : "";
    return escapar ? Escapar_Html(valor) : valor;
  });
}

const ENTIDADES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&nbsp;": " " };

/** Versão em texto de um HTML (e-mail sem parte texto pontua pior em filtros de spam). */
export function Html_Para_Texto(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, rotulo: string) => {
      const limpo = rotulo.replace(/<[^>]+>/g, "").trim();
      return limpo === "" || limpo === href ? href : `${limpo} (${href})`;
    })
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTIDADES[e] ?? e)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
