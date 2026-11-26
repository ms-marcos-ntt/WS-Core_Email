import * as fs from "fs";
import * as path from "path";
import Modelo_Config_JSON from "../../Models/Modelo_Config_JSON.json";
import { Modelo_Configuracao } from "../../Models/Modelo_Configuracao";


/**
 * Raiz do módulo (pasta do package.json). O código roda tanto de Server/ (npm run dev)
 * quanto de dist/Server/ (build); config, SQL e templates ficam sempre em <raiz>/Server.
 */
export function RaizProjeto(): string {
  let pasta = __dirname;
  while (!fs.existsSync(path.join(pasta, "package.json"))) {
    const acima = path.dirname(pasta);
    if (acima === pasta) return path.resolve(__dirname, "..", "..", "..");
    pasta = acima;
  }
  return pasta;
}

/** Caminho do config relativo à raiz do módulo (absolutos ficam como estão). */
export function NaRaiz(caminho: string): string {
  return path.resolve(RaizProjeto(), caminho);
}

export const PASTA_SERVER = path.join(RaizProjeto(), "Server");
export const ARQUIVO_CONFIG = path.join(PASTA_SERVER, "config", "config.cfg");
export const PASTA_SQL = path.join(PASTA_SERVER, "SQL");

export class Erro_Configuracao extends Error { }


function EhObjeto(valor: unknown): valor is Record<string, any> {
  return valor !== null && typeof valor === "object" && !Array.isArray(valor);
}

/** Mescla o config lido sobre o modelo, em qualquer profundidade (listas do config substituem as do modelo). */
export function Mesclar_Com_Padrao(lido: Record<string, any>, padrao: Record<string, any> = Modelo_Config_JSON as Record<string, any>): Record<string, any> {
  const mesclado: Record<string, any> = { ...padrao };
  for (const chave of Object.keys(lido)) {
    const valorLido = lido[chave];
    mesclado[chave] = EhObjeto(valorLido) && EhObjeto(padrao[chave]) ? Mesclar_Com_Padrao(valorLido, padrao[chave]) : valorLido;
  }
  return mesclado;
}


/**
 * Lê o config.cfg completando o que faltar com os padrões. Se não existir, cria a partir do
 * modelo (com SMTP vazio) e lança Erro_Configuracao para que seja preenchido.
 */
export function Carregar_Configuracao(): Modelo_Configuracao {
  if (!fs.existsSync(ARQUIVO_CONFIG)) {
    fs.mkdirSync(path.dirname(ARQUIVO_CONFIG), { recursive: true });
    fs.writeFileSync(ARQUIVO_CONFIG, JSON.stringify(Modelo_Config_JSON, null, 2), "utf8");
    throw new Erro_Configuracao(`Configuração criada em ${ARQUIVO_CONFIG}. Preencha-a (BD, Core e SMTP) e reinicie.`);
  }
  let lido: Record<string, any>;
  try {
    lido = JSON.parse(fs.readFileSync(ARQUIVO_CONFIG, "utf8"));
  } catch (erro) {
    throw new Erro_Configuracao(`Arquivo de configuração inválido (JSON): ${ARQUIVO_CONFIG} - ${(erro as Error).message}`);
  }
  if (!EhObjeto(lido)) throw new Erro_Configuracao(`Arquivo de configuração inválido (esperado um objeto JSON): ${ARQUIVO_CONFIG}`);
  return Mesclar_Com_Padrao(lido) as Modelo_Configuracao;
}
