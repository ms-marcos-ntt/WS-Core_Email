import { Anexo_Validado, Erro_Email, Pedido_Validado } from "../../Models/Email/Tipos";
import { Limites_Email } from "../../Models/Modelo_Configuracao";

/**
 * Validação rígida do pacote `email/enviar`. Tudo que não for reconhecido é recusado
 * (campo desconhecido, tipo errado, e-mail malformado, excesso de tamanho/quantidade).
 * As mensagens dizem QUAL campo falhou, mas não repetem o conteúdo recebido.
 */

const CAMPOS_PERMITIDOS = new Set(["para", "cc", "bcc", "assunto", "texto", "html", "template", "variaveis", "anexos", "responderPara", "referencia"]);
const CAMPOS_ANEXO = new Set(["nome", "conteudoBase64", "tipo"]);

// Local@domínio ASCII (sem IDN, sem "Nome <x@y>", sem comentários). Cobre os formatos usados na prática.
const ENDERECO = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const CONTROLE = /[\u0000-\u001f\u007f]/;
const NOME_TEMPLATE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const NOME_VARIAVEL = /^[A-Za-z][A-Za-z0-9_]{0,49}$/;
const TIPO_MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,60}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,60}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const EXTENSOES_BLOQUEADAS = new Set([
  "exe", "bat", "cmd", "com", "scr", "pif", "msi", "msp", "dll", "js", "jse", "vbs", "vbe", "wsf", "wsh", "ps1", "psm1",
  "jar", "lnk", "reg", "hta", "cpl", "iso", "dmg", "apk", "sh", "app", "docm", "xlsm", "pptm",
]);

const MAX_VARIAVEIS = 50;
const MAX_VALOR_VARIAVEL = 5000;
const MAX_REFERENCIA = 120;
const MAX_NOME_ANEXO = 100;

function Falha(mensagem: string): never {
  throw new Erro_Email("validacao", mensagem);
}

function EhObjeto(valor: unknown): valor is Record<string, unknown> {
  return valor !== null && typeof valor === "object" && !Array.isArray(valor);
}

/** Valida um endereço; devolve em minúsculas ou undefined se inválido. */
export function Normalizar_Endereco(valor: unknown): string | undefined {
  if (typeof valor !== "string") return undefined;
  const endereco = valor.trim();
  if (endereco.length < 6 || endereco.length > 254) return undefined;
  if (!ENDERECO.test(endereco)) return undefined;
  if (endereco.slice(0, endereco.indexOf("@")).length > 64) return undefined;
  return endereco.toLowerCase();
}

function LerLista(valor: unknown, campo: string, obrigatorio: boolean, maximo: number): string[] {
  if (valor === undefined || valor === null) {
    if (obrigatorio) Falha(`Campo obrigatório ausente: ${campo}`);
    return [];
  }
  const lista = typeof valor === "string" ? [valor] : valor;
  if (!Array.isArray(lista)) Falha(`Campo "${campo}" deve ser um e-mail ou uma lista de e-mails`);
  if (lista.length > maximo) Falha(`Campo "${campo}" excede o máximo de ${maximo} destinatários`);
  if (obrigatorio && lista.length === 0) Falha(`Campo obrigatório ausente: ${campo}`);
  return lista.map((item, indice) => {
    const endereco = Normalizar_Endereco(item);
    if (!endereco) Falha(`E-mail inválido em "${campo}" (posição ${indice + 1})`);
    return endereco;
  });
}

function LerTextoOpcional(valor: unknown, campo: string, maximo: number, permiteQuebra: boolean): string | undefined {
  if (valor === undefined || valor === null) return undefined;
  if (typeof valor !== "string") Falha(`Campo "${campo}" deve ser texto`);
  if (valor.length > maximo) Falha(`Campo "${campo}" excede o máximo de ${maximo} caracteres`);
  if (valor.includes("\u0000")) Falha(`Campo "${campo}" contém caracteres inválidos`);
  if (!permiteQuebra && CONTROLE.test(valor)) Falha(`Campo "${campo}" não pode conter quebra de linha nem caracteres de controle`);
  return valor;
}

function LerVariaveis(valor: unknown): Record<string, string> {
  if (valor === undefined || valor === null) return {};
  if (!EhObjeto(valor)) Falha(`Campo "variaveis" deve ser um objeto`);
  const chaves = Object.keys(valor);
  if (chaves.length > MAX_VARIAVEIS) Falha(`Campo "variaveis" excede o máximo de ${MAX_VARIAVEIS} variáveis`);
  const resultado: Record<string, string> = {};
  for (const chave of chaves) {
    if (!NOME_VARIAVEL.test(chave)) Falha(`Nome de variável inválido: use letras, números e _ (começando por letra)`);
    const v = valor[chave];
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") Falha(`Variável "${chave}" deve ser texto, número ou booleano`);
    const texto = String(v);
    if (texto.length > MAX_VALOR_VARIAVEL) Falha(`Variável "${chave}" excede o máximo de ${MAX_VALOR_VARIAVEL} caracteres`);
    if (texto.includes("\u0000")) Falha(`Variável "${chave}" contém caracteres inválidos`);
    resultado[chave] = texto;
  }
  return resultado;
}

function LerAnexos(valor: unknown, limites: Limites_Email): Anexo_Validado[] {
  if (valor === undefined || valor === null) return [];
  if (!Array.isArray(valor)) Falha(`Campo "anexos" deve ser uma lista`);
  if (valor.length > limites.MaxAnexos) Falha(`Campo "anexos" excede o máximo de ${limites.MaxAnexos} anexos`);
  let total = 0;
  return valor.map((item, indice) => {
    const rotulo = `anexos[${indice}]`;
    if (!EhObjeto(item)) Falha(`${rotulo} deve ser um objeto { nome, conteudoBase64, tipo? }`);
    for (const chave of Object.keys(item)) if (!CAMPOS_ANEXO.has(chave)) Falha(`${rotulo}: campo desconhecido "${chave}"`);

    const nome = item.nome;
    if (typeof nome !== "string" || nome.trim() === "" || nome.length > MAX_NOME_ANEXO) Falha(`${rotulo}.nome deve ser um texto de 1 a ${MAX_NOME_ANEXO} caracteres`);
    if (CONTROLE.test(nome) || /[\\/:*?"<>|]/.test(nome) || nome.trim().startsWith(".") || nome.includes("..")) Falha(`${rotulo}.nome contém caracteres não permitidos`);
    const extensao = nome.includes(".") ? nome.slice(nome.lastIndexOf(".") + 1).toLowerCase() : "";
    if (EXTENSOES_BLOQUEADAS.has(extensao)) Falha(`${rotulo}: tipo de arquivo não permitido (.${extensao})`);

    const base64 = item.conteudoBase64;
    if (typeof base64 !== "string" || base64 === "") Falha(`${rotulo}.conteudoBase64 deve ser um texto base64 não vazio`);
    // Confere o tamanho ANTES de decodificar, para não alocar memória com entrada gigante
    if (base64.length > Math.ceil(limites.MaxAnexoBytes / 3) * 4 + 4) Falha(`${rotulo} excede o tamanho máximo de ${limites.MaxAnexoBytes} bytes`);
    if (base64.length % 4 !== 0 || !BASE64.test(base64)) Falha(`${rotulo}.conteudoBase64 não é um base64 válido`);
    const conteudo = Buffer.from(base64, "base64");
    if (conteudo.length === 0) Falha(`${rotulo} está vazio`);
    if (conteudo.length > limites.MaxAnexoBytes) Falha(`${rotulo} excede o tamanho máximo de ${limites.MaxAnexoBytes} bytes`);
    total += conteudo.length;
    if (total > limites.MaxTotalAnexosBytes) Falha(`Os anexos excedem o tamanho total máximo de ${limites.MaxTotalAnexosBytes} bytes`);

    let tipo: string | undefined;
    if (item.tipo !== undefined && item.tipo !== null) {
      if (typeof item.tipo !== "string" || !TIPO_MIME.test(item.tipo)) Falha(`${rotulo}.tipo inválido (esperado algo como "application/pdf")`);
      tipo = item.tipo.toLowerCase();
    }
    return { nome: nome.trim(), conteudo, tipo };
  });
}

/** Valida o JSON recebido em `pacote.dados` e devolve o pedido normalizado. Lança Erro_Email("validacao"). */
export function Validar_Pedido(dadosBrutos: unknown, limites: Limites_Email): Pedido_Validado {
  let dados: unknown = dadosBrutos;
  if (typeof dados === "string") {
    try {
      dados = JSON.parse(dados);
    } catch {
      Falha("Pacote inválido: os dados não são um JSON válido");
    }
  }
  if (!EhObjeto(dados)) Falha("Pacote inválido: esperado um objeto JSON");
  for (const chave of Object.keys(dados)) if (!CAMPOS_PERMITIDOS.has(chave)) Falha(`Campo desconhecido: "${chave}"`);

  const maximo = limites.MaxDestinatarios;
  const para = LerLista(dados.para, "para", true, maximo);
  const cc = LerLista(dados.cc, "cc", false, maximo);
  const bcc = LerLista(dados.bcc, "bcc", false, maximo);

  // Sem repetir o mesmo endereço (para > cc > bcc); o limite vale para o total já deduplicado
  const vistos = new Set<string>();
  const unico = (lista: string[]) => lista.filter((e) => !vistos.has(e) && vistos.add(e));
  const paraU = unico(para);
  const ccU = unico(cc);
  const bccU = unico(bcc);
  if (paraU.length + ccU.length + bccU.length > maximo) Falha(`Total de destinatários excede o máximo de ${maximo}`);

  const assunto = LerTextoOpcional(dados.assunto, "assunto", limites.MaxAssunto, false)?.trim();
  const texto = LerTextoOpcional(dados.texto, "texto", limites.MaxTexto, true);
  const html = LerTextoOpcional(dados.html, "html", limites.MaxHtml, true);
  const referencia = LerTextoOpcional(dados.referencia, "referencia", MAX_REFERENCIA, false)?.trim() || undefined;

  let template: string | undefined;
  if (dados.template !== undefined && dados.template !== null) {
    if (typeof dados.template !== "string" || !NOME_TEMPLATE.test(dados.template)) Falha(`Campo "template" inválido (use letras minúsculas, números, _ e -)`);
    template = dados.template;
  }
  const variaveis = LerVariaveis(dados.variaveis);

  let responderPara: string | undefined;
  if (dados.responderPara !== undefined && dados.responderPara !== null) {
    responderPara = Normalizar_Endereco(dados.responderPara);
    if (!responderPara) Falha(`E-mail inválido em "responderPara"`);
  }

  if (template !== undefined) {
    if (assunto !== undefined || texto !== undefined || html !== undefined) Falha(`Com "template", não envie "assunto", "texto" nem "html" (o conteúdo vem do template)`);
  } else {
    if (Object.keys(variaveis).length > 0) Falha(`"variaveis" só pode ser usado junto com "template"`);
    if (assunto === undefined || assunto === "") Falha(`Campo obrigatório ausente: assunto`);
    if ((texto === undefined || texto.trim() === "") && (html === undefined || html.trim() === "")) Falha(`Informe o corpo da mensagem em "texto" e/ou "html"`);
  }

  const anexos = LerAnexos(dados.anexos, limites);
  return { para: paraU, cc: ccU, bcc: bccU, assunto, texto, html, template, variaveis, anexos, responderPara, referencia };
}
