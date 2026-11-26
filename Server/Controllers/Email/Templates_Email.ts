import * as fs from "fs";
import * as path from "path";
import { Erro_Email } from "../../Models/Email/Tipos";
import { Html_Para_Texto, Substituir_Variaveis, Variaveis_Usadas } from "./Formatacao_Email";

/**
 * Templates em arquivos, uma pasta por template:
 *
 *   <PastaTemplates>/<nome>/assunto.txt   assunto (obrigatório, primeira linha)
 *   <PastaTemplates>/<nome>/corpo.html    corpo HTML (opcional se houver corpo.txt)
 *   <PastaTemplates>/<nome>/corpo.txt     corpo em texto (opcional se houver corpo.html)
 *
 * Variáveis: `{{nome}}`. No HTML o valor é escapado (sem risco de injetar HTML); no texto e
 * no assunto entra como veio (no assunto, quebras de linha viram espaço). Variável usada no
 * template e não informada recusa o envio. Os arquivos são lidos a cada envio: editar um
 * template não exige reiniciar o módulo.
 */

const NOME_TEMPLATE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface Template_Renderizado { assunto: string; texto?: string; html?: string }

export class Templates_Email {
  public constructor(private readonly pasta: string) {}

  /** Nomes dos templates disponíveis. */
  public Listar(): string[] {
    if (!fs.existsSync(this.pasta)) return [];
    return fs.readdirSync(this.pasta, { withFileTypes: true })
      .filter((d) => d.isDirectory() && NOME_TEMPLATE.test(d.name) && fs.existsSync(path.join(this.pasta, d.name, "assunto.txt")))
      .map((d) => d.name)
      .sort();
  }

  private Ler(nome: string, arquivo: string): string | undefined {
    const caminho = path.join(this.pasta, nome, arquivo);
    return fs.existsSync(caminho) ? fs.readFileSync(caminho, "utf8").replace(/^﻿/, "") : undefined;
  }

  public Renderizar(nome: string, variaveis: Record<string, string>, maxAssunto: number): Template_Renderizado {
    if (!NOME_TEMPLATE.test(nome)) throw new Erro_Email("validacao", "Nome de template inválido");
    const pastaTemplate = path.resolve(this.pasta, nome);
    // Defesa extra contra path traversal (o regex já impede, mas o custo é zero)
    if (path.dirname(pastaTemplate) !== path.resolve(this.pasta) || !fs.existsSync(pastaTemplate)) {
      throw new Erro_Email("template_invalido", `Template "${nome}" não existe. Disponíveis: ${this.Listar().join(", ") || "(nenhum)"}`);
    }

    const assuntoBruto = this.Ler(nome, "assunto.txt");
    const html = this.Ler(nome, "corpo.html");
    const texto = this.Ler(nome, "corpo.txt");
    if (assuntoBruto === undefined || (html === undefined && texto === undefined)) {
      throw new Erro_Email("template_invalido", `Template "${nome}" está incompleto (precisa de assunto.txt e de corpo.html e/ou corpo.txt)`);
    }

    const usadas = new Set([assuntoBruto, html ?? "", texto ?? ""].flatMap((t) => Variaveis_Usadas(t)));
    const faltando = [...usadas].filter((v) => !Object.prototype.hasOwnProperty.call(variaveis, v));
    if (faltando.length > 0) {
      throw new Erro_Email("validacao", `Faltam variáveis do template "${nome}": ${faltando.sort().join(", ")}`);
    }

    const assunto = Substituir_Variaveis(assuntoBruto.split(/\r?\n/)[0], variaveis, false).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    if (assunto === "") throw new Erro_Email("validacao", `O assunto do template "${nome}" ficou vazio com essas variáveis`);
    if (assunto.length > maxAssunto) throw new Erro_Email("validacao", `O assunto do template "${nome}" excede o máximo de ${maxAssunto} caracteres`);

    const htmlFinal = html === undefined ? undefined : Substituir_Variaveis(html, variaveis, true);
    const textoFinal = texto !== undefined ? Substituir_Variaveis(texto, variaveis, false) : (htmlFinal ? Html_Para_Texto(htmlFinal) : undefined);
    return { assunto, texto: textoFinal, html: htmlFinal };
  }
}
