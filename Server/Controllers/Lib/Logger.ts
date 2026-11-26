import colors from 'ansi-colors';
import * as fs from 'fs';
import * as path from 'path';
import { formatWithOptions } from 'util';


/**
 * Opções globais de log (bloco LOG do config.cfg).
 */
export interface Opcoes_Logger {
    // Escreve no console
    Console: boolean;
    // Escreve em arquivo
    Arquivo: boolean;
    // Pasta dos arquivos de log (relativa ao diretório de execução, se não for absoluta)
    LocalArquivo: string;
    // Período (segundos) de cada arquivo de log antes de começar outro. Ex.: 86400 = um arquivo por dia
    Rotatividade: number;
}


/**
 * Logger do Core. A configuração é global (estática): todas as instâncias
 * criadas com `new Logger()` passam a respeitar o que for definido em `Logger.Configurar`.
 */
class Logger {

    private static opcoes: Opcoes_Logger = {
        Console: true,
        Arquivo: false,
        LocalArquivo: "./log/wscore/",
        Rotatividade: 86400,
    };

    private static prefixoArquivo = "wscore_core";
    private static periodoAtual = -1;
    private static stream?: fs.WriteStream;


    /**
     * Aplica o bloco LOG do config.cfg. Se a pasta de log não puder ser criada,
     * desativa a gravação em arquivo e avisa no console (o Core continua rodando).
     */
    static Configurar(opcoes: Partial<Opcoes_Logger>, prefixoArquivo?: string) {
        Logger.opcoes = { ...Logger.opcoes, ...opcoes };
        if (prefixoArquivo) Logger.prefixoArquivo = prefixoArquivo;
        if (!(Number(Logger.opcoes.Rotatividade) > 0)) Logger.opcoes.Rotatividade = 86400;

        Logger.FecharArquivo();

        if (Logger.opcoes.Arquivo) {
            try {
                fs.mkdirSync(Logger.PastaLog(), { recursive: true });
            } catch (err) {
                Logger.opcoes.Arquivo = false;
                console.log(colors.yellow("[Warning]"), "Não foi possível criar a pasta de log", Logger.PastaLog(),
                    "- gravação em arquivo desativada.", err);
            }
        }
    }

    /** Fecha o arquivo de log aberto, aguardando a gravação pendente (usado no desligamento). */
    static FecharArquivo(): Promise<void> {
        const stream = Logger.stream;
        Logger.stream = undefined;
        Logger.periodoAtual = -1;
        return new Promise((resolve) => {
            if (!stream) {
                resolve();
                return;
            }
            stream.end(() => resolve());
        });
    }


    Log(...args: any[]) {
        Logger.Escrever("Log", colors.gray, args);
    }
    Error(...args: any[]) {
        Logger.Escrever("Error", colors.red, args);
    }
    Warning(...args: any[]) {
        Logger.Escrever("Warning", colors.yellow, args);
    }
    Info(...args: any[]) {
        Logger.Escrever("Info", colors.blueBright, args);
    }
    System(...args: any[]) {
        Logger.Escrever("System", colors.yellow, args);
    }


    private static Escrever(nivel: string, cor: (s: string) => string, args: any[]) {
        const agora = new Date();
        const hora = FormatarHora(agora);

        if (Logger.opcoes.Console) {
            if (nivel === "Log") {
                console.log(colors.gray("(" + hora + ") "), ...args);
            } else {
                console.log(colors.gray("(" + hora + ") "), cor("[" + nivel + "]"), ...args);
            }
        }

        if (Logger.opcoes.Arquivo) {
            try {
                const texto = colors.unstyle(formatWithOptions({ colors: false, depth: 4 }, ...args));
                Logger.Arquivo(agora)?.write("(" + hora + ") [" + nivel + "] " + texto + "\n");
            } catch {
                // Falha de gravação em arquivo nunca deve derrubar o Core
            }
        }
    }

    /** Retorna o stream do período atual, abrindo um arquivo novo quando o período muda. */
    private static Arquivo(agora: Date): fs.WriteStream | undefined {
        const periodoMs = Number(Logger.opcoes.Rotatividade) * 1000;
        // Períodos alinhados ao horário local (ex.: com 86400 o arquivo vira à meia-noite local, não UTC)
        const deslocamentoMs = agora.getTimezoneOffset() * 60000;
        const periodo = Math.floor((agora.getTime() - deslocamentoMs) / periodoMs);

        if (periodo !== Logger.periodoAtual || Logger.stream === undefined) {
            Logger.stream?.end();
            const inicio = FormatarHora(new Date(periodo * periodoMs + deslocamentoMs)).replace(/[: ]/g, "-").replace(/\.\d+$/, "");
            const arquivo = path.join(Logger.PastaLog(), Logger.prefixoArquivo + "_" + inicio + ".log");
            Logger.stream = fs.createWriteStream(arquivo, { flags: "a" });
            Logger.stream.on("error", (err) => {
                Logger.opcoes.Arquivo = false;
                console.log(colors.yellow("[Warning]"), "Erro ao gravar log em arquivo - gravação desativada:", err.message);
            });
            Logger.periodoAtual = periodo;
        }
        return Logger.stream;
    }

    private static PastaLog(): string {
        return path.resolve(process.cwd(), Logger.opcoes.LocalArquivo);
    }
}


function FormatarHora(data: Date): string {
    const p = (n: number, t = 2) => String(n).padStart(t, "0");
    return data.getFullYear() + "-" + p(data.getMonth() + 1) + "-" + p(data.getDate()) + " " +
        p(data.getHours()) + ":" + p(data.getMinutes()) + ":" + p(data.getSeconds()) + "." + p(data.getMilliseconds(), 3);
}

export { Logger }
