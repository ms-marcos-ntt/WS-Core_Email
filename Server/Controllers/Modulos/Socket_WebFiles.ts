import * as fs from "node:fs";
import * as path from "node:path";
import { Modelo_Configuracao } from "../../Models/Modelo_Configuracao";
import { Pacotes_Socket } from "../../Models/Modulos/Pacotes_Socket";
import { Logger } from "../Lib/Logger";
import { NaRaiz } from "../Lib/Configuracao";
import { Socket_Client } from "./Socket_Client";

type Callback = (retorno: unknown) => void;

// Só arquivos de tela (texto)
const EXTENSOES_PERMITIDAS = new Set([".html", ".js", ".css", ".json", ".svg", ".txt", ".map"]);

/**
 * Resolve o arquivo pedido dentro da pasta de telas. null se sair da pasta, tiver extensão não
 * permitida ou não existir.
 */
export function Resolver_Arquivo_Web(pastaBase: string, caminhoPedido: unknown): string | null {
  if (typeof caminhoPedido !== "string" || caminhoPedido.trim() === "" || caminhoPedido.includes("\0")) return null;
  const base = path.resolve(pastaBase);
  const alvo = path.resolve(base, caminhoPedido.replace(/\\/g, "/").replace(/^\/+/, ""));
  if (!alvo.startsWith(base + path.sep)) return null;
  if (!EXTENSOES_PERMITIDAS.has(path.extname(alvo).toLowerCase())) return null;
  try {
    if (!fs.statSync(alvo).isFile()) return null;
    const real = fs.realpathSync(alvo);
    if (!real.startsWith(fs.realpathSync(base) + path.sep)) return null;
  } catch {
    return null;
  }
  return alvo;
}

export class Socket_WebFiles {
  private readonly logger = new Logger();
  private readonly pasta: string;
  private readonly prefixo: string;

  public constructor(config: Modelo_Configuracao, private readonly core: Socket_Client) {
    this.pasta = NaRaiz(config.WebFiles?.Pasta_Arquivos_Html ?? "./Views/_web");
    this.prefixo = `modulos/${config.modulo.nome}/`;
  }

  public Registrar(): void {
    this.core.Escutar("webfiles", async (pacote: Pacotes_Socket, callback: Callback) => {
      let dados: { path?: unknown };
      try {
        dados = pacote?.dados ? JSON.parse(pacote.dados) as { path?: unknown } : {};
      } catch {
        callback({ status: "Erro", mensagem: "Dados inválidos" });
        return;
      }
      // Telas antigas pedem "modulos/<nome>/arquivo"; o prefixo é opcional
      const pedido = typeof dados.path === "string" ? dados.path.replace(/^\.\//, "") : dados.path;
      const relativo = typeof pedido === "string" && pedido.startsWith(this.prefixo) ? pedido.slice(this.prefixo.length) : pedido;
      const arquivo = Resolver_Arquivo_Web(this.pasta, relativo);
      if (arquivo === null) {
        this.logger.Warning("[Email/WebFiles] Arquivo recusado ou inexistente:", String(dados.path).slice(0, 200));
        callback({ status: "Erro", mensagem: "Arquivo não encontrado" });
        return;
      }
      callback({ status: "OK", arquivo: await fs.promises.readFile(arquivo, "utf8") });
    });
  }
}
