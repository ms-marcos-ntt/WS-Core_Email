import { Logger } from "./Logger";
import { Erro_Email } from "../../Models/Email/Tipos";

/**
 * Tratamento de erros sem expor dados pessoais nem segredos.
 *
 * Erros do MySQL trazem o SQL com os valores e mensagens como "Duplicate entry '...'"; erros do
 * SMTP podem citar usuário/senha/endereços. Nada disso vai para o log nem para quem chamou.
 */

const CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const CNPJ = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const ENTRE_ASPAS = /'[^']*'/g;

/** Mascara CPF, CNPJ e e-mail em um texto. */
export function Mascarar_Dados_Pessoais(texto: string): string {
  return texto.replace(CNPJ, "[cnpj]").replace(CPF, "[cpf]").replace(EMAIL, "[email]");
}

/**
 * Remove de um texto qualquer ocorrência dos segredos informados (senha SMTP, usuário SMTP,
 * segredo do Core...) e de seus equivalentes em base64 (formato usado no AUTH do SMTP).
 */
export function Mascarar_Segredos(texto: string, segredos: Array<string | undefined>): string {
  let resultado = texto;
  for (const segredo of segredos) {
    if (!segredo || segredo.length < 3) continue;
    for (const variante of new Set([segredo, Buffer.from(segredo).toString("base64")])) {
      resultado = resultado.split(variante).join("[segredo]");
    }
  }
  return resultado;
}

interface Erro_MySQL { code?: unknown; errno?: unknown; sqlMessage?: unknown; sql?: unknown }

function EhErroMySQL(erro: unknown): erro is Erro_MySQL {
  return typeof erro === "object" && erro !== null && ("sqlMessage" in erro || "sql" in erro);
}

/** Descrição do erro para o log: sem o SQL e sem valores entre aspas da mensagem do banco. */
export function Descrever_Erro(erro: unknown, segredos: Array<string | undefined> = []): string {
  let texto: string;
  if (EhErroMySQL(erro)) {
    const mensagem = String(erro.sqlMessage ?? "").replace(ENTRE_ASPAS, "'…'");
    texto = `MySQL ${String(erro.code ?? "")} (${String(erro.errno ?? "")}): ${mensagem}`;
  } else if (erro instanceof Error) {
    texto = `${erro.name}: ${erro.message}`;
  } else {
    texto = String(erro);
  }
  return Mascarar_Segredos(Mascarar_Dados_Pessoais(texto), segredos);
}

/**
 * Mensagem para quem chamou. Erros do próprio módulo (Erro_Email) passam como estão; erros do
 * banco e qualquer outro viram mensagem genérica.
 */
export function Mensagem_Para_Tela(erro: unknown): string {
  if (erro instanceof Erro_Email) return erro.message;
  return "Erro interno ao processar o envio de e-mail";
}

/** Para os handlers: registra o erro no log (sem dados pessoais) e devolve a mensagem segura. */
export function Erro_Para_Tela(evento: string, erro: unknown, segredos: Array<string | undefined> = []): string {
  new Logger().Warning(`[Email] ${evento}:`, Descrever_Erro(erro, segredos));
  return Mensagem_Para_Tela(erro);
}
