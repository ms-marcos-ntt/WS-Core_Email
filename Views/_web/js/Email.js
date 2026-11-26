/*
 * WSCore_Email — telas "Histórico de envios" (Controle_Tela_Tabela) e "Uso e limites" (Controle_Tela, layout livre).
 *
 * Um arquivo só para as duas telas: os dois itens de menu (email/historico e email/uso) apontam para
 * ele em `load_dependencia`; o guard abaixo impede registrar os listeners duas vezes.
 *
 * Segurança: TODO texto que vem do servidor/banco passa por `esc()` antes de entrar em HTML; o que vira
 * atributo/estilo (faixa, percentual, status) só entra depois de passar por lista fixa ou Number().
 * A permissão de verdade é conferida no servidor em cada evento; aqui só se esconde o que o usuário não pode usar.
 */
if (!window._TelaWSCoreEmail_Registrada) {
    window._TelaWSCoreEmail_Registrada = true;

    (function () {
        const DESTINO = "WSCore_Email/*";
        Carregar_CSS("/modulos/WSCore_Email/css/Email.css");

        // ── Utilidades ────────────────────────────────────────────────────────────────

        const esc = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
        const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
        const nBr = (v) => num(v).toLocaleString("pt-BR");
        /** "2026-11-26 08:51:21.379" (horário de São Paulo, como o módulo grava) -> "26/11/2026 08:51:21". Sem conversão de fuso. */
        const dh = (v) => {
            const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(v || ""));
            return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}:${m[6]}` : "";
        };
        const dia = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || "")); return m ? `${m[3]}/${m[2]}` : ""; };
        const bytes = (v) => { const n = num(v); return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} KB` : `${(n / 1048576).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`; };

        const STATUS = { enviado: "Enviado", falhou: "Falhou", enviando: "Enviando" };
        const badge = (status) => { const s = Object.prototype.hasOwnProperty.call(STATUS, status) ? status : "outro"; return `<span class="email_badge email_badge_${s}">${esc(STATUS[s] || status)}</span>`; };

        // Explicação curta dos códigos de erro (tooltip). Códigos desconhecidos aparecem como vieram.
        const ERROS = {
            validacao: "Pedido inválido (campo ou variável de template)", template_invalido: "Template inexistente ou incompleto", nao_autorizado: "Módulo/usuário sem autorização",
            limite_excedido: "Rate limit do config.cfg", limite_diario: "Limite diário atingido", limite_mensal: "Limite mensal atingido", pausado: "Envios pausados",
            nao_configurado: "SMTP sem credenciais no config.cfg", smtp_autenticacao: "Usuário/senha SMTP recusados", smtp_conexao: "Não conectou ao servidor SMTP",
            smtp_timeout: "Tempo esgotado no servidor SMTP", smtp_destinatario: "Servidor SMTP recusou remetente/destinatários", smtp_erro: "Servidor SMTP recusou a mensagem", interno: "Erro interno",
        };
        const codigoErro = (c) => (c ? `<span class="email_codigo" title="${esc(ERROS[c] || "")}">${esc(c)}</span>` : "");

        const FAIXAS = { sem_limite: "Sem limite", normal: "Normal", alerta: "Alerta", esgotado: "Esgotado" };

        function aviso(mensagem, titulo) {
            if (typeof _Notificacoes !== "undefined" && _Notificacoes && typeof _Notificacoes.Adicionar_Notificacao === "function") {
                _Notificacoes.Adicionar_Notificacao(Date.now(), String(mensagem == null ? "" : mensagem), { Titulo: titulo || "Atenção", Cor: "#fff", Background: "#2e1a1a" }, "", {});
                return;
            }
            abrirModal(`<div class="email_modal" style="width:420px"><h3>${esc(titulo || "Atenção")}</h3><p>${esc(mensagem)}</p><div class="email_modal_acoes"><button type="button" class="email_btn email_fechar">OK</button></div></div>`);
        }

        function abrirModal(html) {
            const overlay = document.createElement("div");
            overlay.className = "email_modal_overlay";
            overlay.innerHTML = html;
            document.body.appendChild(overlay);
            let fechado = false;
            const teclas = (e) => { if (e.key === "Escape") fechar(); };
            const fechar = () => { if (fechado) return; fechado = true; document.removeEventListener("keydown", teclas); overlay.remove(); };
            document.addEventListener("keydown", teclas);
            overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) fechar(); });
            overlay.querySelectorAll(".email_fechar").forEach((b) => b.addEventListener("click", fechar));
            return { overlay, fechar };
        }

        function confirmar(titulo, texto, rotulo, aoConfirmar) {
            const m = abrirModal(`<div class="email_modal" style="width:460px"><h3>${esc(titulo)}</h3><p>${esc(texto)}</p>
                <div class="email_modal_acoes"><button type="button" class="email_btn email_fechar">Cancelar</button><button type="button" class="email_btn email_btn_primario email_ok">${esc(rotulo)}</button></div></div>`);
            m.overlay.querySelector(".email_ok").addEventListener("click", () => { m.fechar(); aoConfirmar(); });
        }

        function chamar(evento, dados, callback) {
            _WebSocket.Emit(evento, DESTINO, dados || {}, (r) => callback(r && typeof r === "object" ? r : { status: "Erro", mensagem: "Resposta inválida" }));
        }

        // ── Eventos de menu ──────────────────────────────────────────────────────────

        _Eventos.on("open/email/historico", () => new Controle_Tela_Tabela(_configHistorico()).Abrir());
        _Eventos.on("open/email/uso", () => _abrirUso());

        // ══════════════════════════════════════════════════════════════════════════════
        //  HISTÓRICO (lista)
        // ══════════════════════════════════════════════════════════════════════════════

        let _filtros = {};
        let _opcoes = { modulos: [], status: ["enviado", "falhou", "enviando"] };

        function _col(chave, titulo, renderizar, extra) {
            return Object.assign({ chave, titulo, tipo: "custom", larguraMin: "110px", ordenavel: true, renderizar }, extra || {});
        }

        function _configHistorico() {
            _filtros = {};
            chamar("email/historico/opcoes", {}, (r) => { if (r.status === "OK" && r.dados) _opcoes = r.dados; });
            return {
                titulo: "Histórico de envios",
                icone: "history",
                instanciaUnica: true,
                chaveUnica: "wscore_email_historico",
                limiteRegistros: 50,
                ordemPadrao: "criadoEm",
                direcaoPadrao: "desc",

                // Ordenação e paginação são feitas no servidor; `ordem` é a chave da coluna (lista fixa lá).
                carregarDados(params, callback) {
                    const f = Object.assign({}, _filtros, { pagina: params.pagina, limite: params.limite, busca: params.pesquisa || undefined, ordem: params.ordem, direcao: params.direcao });
                    chamar("email/historico/listar", f, (r) => {
                        if (r.status !== "OK") { callback({ erro: true, mensagem: r.mensagem || "Falha ao buscar o histórico." }); return; }
                        callback({ registros: r.dados.items, total: r.dados.total });
                    });
                },

                iconeVazio: "forward_to_inbox",
                textoVazio: "Nenhum envio encontrado",
                textoVazioSub: "Ainda não há envios registrados ou nenhum corresponde aos filtros aplicados.",
                textoVazioSem: "Nenhum envio encontrado com esses filtros.",

                colunas: [
                    _col("criadoEm", "Data/hora", (r) => esc(dh(r.criadoEm)), { larguraMin: "150px" }),
                    _col("modulo", "Módulo", (r) => esc(r.modulo), { larguraMin: "140px" }),
                    _col("referencia", "Referência", (r) => esc(r.referencia || ""), { larguraMin: "150px", larguraMax: "240px" }),
                    _col("para", "Destinatários", (r) => `${esc(r.para)}${num(r.qtdDestinatarios) > 1 ? ` <span class="email_badge email_badge_outro" title="Total de destinatários (para + cc + bcc)">${nBr(r.qtdDestinatarios)}</span>` : ""}`, { larguraMin: "200px", larguraMax: "320px" }),
                    _col("assunto", "Assunto", (r) => esc(r.assunto), { larguraMin: "200px", larguraMax: "320px" }),
                    _col("template", "Template", (r) => esc(r.template || ""), { larguraMin: "130px" }),
                    _col("status", "Status", (r) => badge(r.status), { larguraMin: "95px" }),
                    _col("erroCodigo", "Erro", (r) => codigoErro(r.erroCodigo), { larguraMin: "130px" }),
                    _col("tamanho", "Tamanho / anexos", (r) => `${esc(bytes(r.tamanho))}${num(r.anexos) > 0 ? ` · ${nBr(r.anexos)} anexo${num(r.anexos) > 1 ? "s" : ""}` : ""}`, { larguraMin: "130px" }),
                ],

                botoes: [
                    { id: "detalhes", label: "Detalhes", icone: "visibility", tipo: "primario", grupo: 1, requerSelecao: -1, title: "Ver o envio selecionado por inteiro", aoClicar(sel) { _abrirDetalhe(sel[0].id); } },
                    { id: "filtros", label: "Filtros", icone: "filter_alt", tipo: "padrao", grupo: 2, requerSelecao: 0, title: "Filtrar por status, módulo e período", aoClicar(_s, _d, tela) { _abrirFiltros(tela); } },
                    { id: "atualizar", label: "Atualizar", icone: "refresh", tipo: "padrao", grupo: 2, requerSelecao: 0, aoClicar(_s, _d, tela) { tela.Recarregar(); } },
                    { id: "uso", label: "Uso e limites", icone: "speed", tipo: "padrao", grupo: 3, requerSelecao: 0, title: "Consumo, limites e pausa dos envios", aoClicar() { _Eventos.emit("open/email/uso", {}); } },
                ],
            };
        }

        function _abrirFiltros(tela) {
            const opcoesStatus = ['<option value="">Todos</option>'].concat((_opcoes.status || []).map((s) => `<option value="${esc(s)}"${_filtros.status === s ? " selected" : ""}>${esc(STATUS[s] || s)}</option>`)).join("");
            const opcoesModulo = ['<option value="">Todos</option>'].concat((_opcoes.modulos || []).map((m) => `<option value="${esc(m)}"${_filtros.modulo === m ? " selected" : ""}>${esc(m)}</option>`)).join("");
            const m = abrirModal(`<form class="email_modal email_form" style="width:460px" novalidate><h3>Filtros</h3>
                <label>Status<select name="status">${opcoesStatus}</select></label>
                <label>Módulo solicitante<select name="modulo">${opcoesModulo}</select></label>
                <div class="email_linha"><label>De<input type="date" name="de" value="${esc(_filtros.de || "")}"></label><label>Até<input type="date" name="ate" value="${esc(_filtros.ate || "")}"></label></div>
                <p class="email_form_dica">Datas no horário de Brasília. A busca por texto é a caixa de pesquisa da tela.</p>
                <p class="email_erro_form" hidden></p>
                <div class="email_modal_acoes"><button type="button" class="email_btn email_fechar">Cancelar</button><button type="button" class="email_btn email_limpar">Limpar filtros</button><button type="submit" class="email_btn email_btn_primario">Aplicar</button></div></form>`);
            const form = m.overlay.querySelector("form");
            const aplicar = (novos) => {
                _filtros = {};
                Object.keys(novos).forEach((k) => { if (novos[k]) _filtros[k] = novos[k]; });
                const n = Object.keys(_filtros).length;
                tela.AtualizarBotao("filtros", { label: n ? `Filtros (${n})` : "Filtros" });
                tela.Recarregar();
            };
            m.overlay.querySelector(".email_limpar").addEventListener("click", () => { m.fechar(); aplicar({}); });
            form.addEventListener("submit", (e) => {
                e.preventDefault();
                const de = form.de.value, ate = form.ate.value;
                if (de && ate && de > ate) { const p = form.querySelector(".email_erro_form"); p.textContent = "A data inicial não pode ser depois da final."; p.hidden = false; return; }
                m.fechar();
                aplicar({ status: form.status.value, modulo: form.modulo.value, de, ate });
            });
        }

        function _abrirDetalhe(id) {
            chamar("email/historico/obter", { id }, (r) => {
                if (r.status !== "OK") { aviso(r.mensagem || "Não foi possível abrir o envio.", "Detalhes"); return; }
                const d = r.dados;
                const linha = (rotulo, valor) => `<div class="email_det_linha"><dt>${esc(rotulo)}</dt><dd>${valor === "" || valor == null ? "<span class=\"email_vazio\">—</span>" : valor}</dd></div>`;
                const lista = (v) => (v ? esc(v).split(", ").join("<br>") : "");
                abrirModal(`<div class="email_modal email_modal_larga"><h3>Envio #${esc(d.id)} ${badge(d.status)}</h3>
                    <dl class="email_detalhe">
                        ${linha("Criado em", esc(dh(d.criadoEm)))}${linha("Concluído em", esc(dh(d.concluidoEm)))}
                        ${linha("Módulo solicitante", esc(d.modulo))}${linha("Referência", esc(d.referencia))}${linha("Usuário (id)", d.usuarioId == null ? "" : esc(d.usuarioId))}
                        ${linha("Assunto", esc(d.assunto))}${linha("Template", esc(d.template))}
                        ${linha("Para", lista(d.para))}${linha("Cc", lista(d.cc))}${linha("Cco", lista(d.bcc))}
                        ${linha("Destinatários / aceitos", `${nBr(d.qtdDestinatarios)} / ${nBr(d.qtdAceitos)}`)}
                        ${linha("Anexos / tamanho", `${nBr(d.anexos)} / ${esc(bytes(d.tamanho))}`)}
                        ${linha("Transporte", esc(d.transporte))}${linha("Message-ID", esc(d.messageId))}
                        ${linha("Código do erro", codigoErro(d.erroCodigo))}${linha("Detalhe do erro", d.erro ? `<pre class="email_pre">${esc(d.erro)}</pre>` : "")}
                    </dl>
                    <p class="email_form_dica">O corpo da mensagem e os anexos não são guardados.</p>
                    <div class="email_modal_acoes"><button type="button" class="email_btn email_fechar">Fechar</button></div></div>`);
            });
        }

        // ══════════════════════════════════════════════════════════════════════════════
        //  USO E LIMITES (tela livre)
        // ══════════════════════════════════════════════════════════════════════════════

        function _abrirUso() {
            const ID_TELA = "wscore_email_uso_" + _GeraString().substring(0, 10);
            const tela = new Controle_Tela(ID_TELA, "Uso e limites de e-mail");

            // O 5º argumento fecha a aba (sem ele a aba não fecha).
            Adicionar_Aba_Superior(ID_TELA, "Uso e limites de e-mail", window._Favoritos?.EhFavoritado(ID_TELA) ?? false, () => tela.Abrir_Tela(), () => tela.Fechar_Tela());

            tela.instancia_tela = document.createElement("div");
            tela.instancia_tela.id = ID_TELA;
            tela.instancia_tela.className = "wscore_tela_holder hide";
            (document.getElementById("wscore_conteudo_principal") ?? document.body).appendChild(tela.instancia_tela);

            tela.instancia_tela.innerHTML = `<div class="email_uso">
                <div class="email_uso_header"><h2>Uso e limites de e-mail</h2>
                    <div class="email_uso_acoes"><label>Período <select class="email_periodo"><option value="7">7 dias</option><option value="30">30 dias</option></select></label>
                    <button type="button" class="email_btn email_atualizar">Atualizar</button></div></div>
                <div class="email_uso_corpo"><p class="email_carregando">Carregando...</p></div></div>`;

            const corpo = tela.instancia_tela.querySelector(".email_uso_corpo");
            const seletor = tela.instancia_tela.querySelector(".email_periodo");
            const carregar = () => {
                corpo.innerHTML = '<p class="email_carregando">Carregando...</p>';
                chamar("email/uso/resumo", { periodo: Number(seletor.value) === 30 ? 30 : 7 }, (r) => {
                    if (r.status !== "OK") { corpo.innerHTML = `<p class="email_carregando">Falha ao carregar: ${esc(r.mensagem || "erro desconhecido")}</p>`; return; }
                    _renderizarUso(corpo, r.dados, carregar);
                });
            };
            tela.instancia_tela.querySelector(".email_atualizar").addEventListener("click", carregar);
            seletor.addEventListener("change", carregar);
            carregar();

            tela.Abrir_Tela();
            _LogAtividades.Registrar("Aberto: Uso e limites de e-mail", "info");
        }

        function _medidor(titulo, m, rodape) {
            const faixa = Object.prototype.hasOwnProperty.call(FAIXAS, m.faixa) ? m.faixa : "sem_limite";
            const pct = m.percentual == null ? 0 : Math.max(0, Math.min(100, num(m.percentual)));
            return `<div class="email_card email_faixa_${faixa}">
                <div class="email_card_rotulo">${esc(titulo)}</div>
                <div class="email_card_valor">${nBr(m.usado)}<span class="email_card_de">${m.limite > 0 ? ` de ${nBr(m.limite)}` : " (sem limite)"}</span></div>
                ${m.limite > 0 ? `<div class="email_barra" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(titulo)}"><div class="email_barra_valor" style="width:${pct}%"></div></div>
                <div class="email_card_pct">${esc(String(m.percentual).replace(".", ","))}% · ${esc(FAIXAS[faixa])}</div>` : `<div class="email_card_pct">${esc(FAIXAS[faixa])}</div>`}
                ${rodape ? `<div class="email_card_rodape">${esc(rodape)}</div>` : ""}</div>`;
        }

        function _grafico(serie) {
            const max = Math.max(1, ...serie.map((p) => num(p.destinatariosAceitos) + num(p.falhas)));
            const L = 100 / serie.length;
            const barras = serie.map((p, i) => {
                const a = num(p.destinatariosAceitos), f = num(p.falhas);
                const ha = (a / max) * 100, hf = (f / max) * 100;
                const rotulo = `${dia(p.dia)}: ${a} destinatários aceitos, ${f} falha(s), ${num(p.mensagens)} mensagem(ns)`;
                const x = i * L + L * 0.15, w = L * 0.7;
                return `<g><title>${esc(rotulo)}</title><rect x="${x}" y="${100 - ha - hf}" width="${w}" height="${hf}" class="email_g_falha"/><rect x="${x}" y="${100 - ha}" width="${w}" height="${ha}" class="email_g_ok"/></g>`;
            }).join("");
            const passo = serie.length > 14 ? 5 : 1;
            const datas = serie.map((p, i) => ((i % passo === 0 || i === serie.length - 1) ? `<span style="left:${i * L + L / 2}%">${esc(dia(p.dia))}</span>` : "")).join("");
            return `<div class="email_grafico"><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Destinatários aceitos e falhas por dia">${barras}</svg><div class="email_g_datas">${datas}</div>
                <div class="email_legenda"><span><i class="email_g_ok"></i> aceitos (consomem cota)</span><span><i class="email_g_falha"></i> falhas</span><span class="email_dim">pico: ${nBr(max)}</span></div></div>`;
        }

        function _renderizarUso(corpo, d, recarregar) {
            const c = d.controle, cfg = d.configCfg || {};
            const avisos = (d.avisos || []).map((a) => `<div class="email_aviso email_aviso_${a.nivel === "erro" ? "erro" : "aviso"}" role="alert">${esc(a.mensagem)}</div>`).join("");
            const tx = d.taxaFalha || {};
            const modulos = (d.porModulo || []).map((l) => `<tr><td>${esc(l.modulo)}</td><td class="email_n">${nBr(l.mensagens)}</td><td class="email_n">${nBr(l.destinatariosAceitos)}</td><td class="email_n">${nBr(l.falhas)}</td></tr>`).join("") || '<tr><td colspan="4" class="email_vazio">Nenhum envio no período.</td></tr>';
            const status = (d.porStatus || []).map((l) => `<span class="email_chip">${badge(l.status)} ${nBr(l.mensagens)} mensagem(ns) · ${nBr(l.destinatarios)} destinatário(s)</span>`).join("") || '<span class="email_vazio">Nenhum envio no período.</span>';
            const erros = (d.ultimosErros || []).map((e) => `<tr><td>${esc(dh(e.criadoEm))}</td><td>${esc(e.modulo)}</td><td>${codigoErro(e.codigo)}</td><td>${esc(e.referencia || "")}</td></tr>`).join("") || '<tr><td colspan="4" class="email_vazio">Nenhuma falha registrada.</td></tr>';
            const rotuloChave = { limite_diario: "Limite diário", limite_mensal: "Limite mensal", percentual_alerta: "% de alerta", pausado: "Pausa" };
            const valorChave = (k, v) => (k === "pausado" ? (v === "1" ? "ligada" : "desligada") : (v === "0" && k.startsWith("limite") ? "sem limite" : v));
            const hist = (d.historicoControle || []).map((h) => `<tr><td>${esc(dh(h.alteradoEm))}</td><td>${esc(rotuloChave[h.chave] || h.chave)}</td><td>${esc(valorChave(h.chave, h.antes))} → ${esc(valorChave(h.chave, h.depois))}</td><td>usuário #${esc(h.alteradoPor == null ? "?" : h.alteradoPor)}</td></tr>`).join("") || '<tr><td colspan="4" class="email_vazio">Nenhuma alteração.</td></tr>';
            const rl = cfg.rateLimit || {}, lim = cfg.limites || {}, smtp = cfg.smtp || {};

            const campo = (nome, rotulo, valor, dica) => `<label>${esc(rotulo)}<input type="text" inputmode="numeric" name="${nome}" value="${esc(valor)}" ${d.podeAdministrar ? "" : "disabled"} autocomplete="off"><small>${esc(dica)}</small></label>`;
            const controle = `<form class="email_form email_controle" novalidate>
                <div class="email_linha">
                    ${campo("limiteDiario", "Limite diário (destinatários)", c.limiteDiario, "0 = sem limite")}
                    ${campo("limiteMensal", "Limite mensal (destinatários)", c.limiteMensal, "0 = sem limite")}
                    ${campo("percentualAlerta", "Avisar a partir de (%)", c.percentualAlerta, "1 a 100 (padrão 80)")}
                </div>
                <label class="email_check"><input type="checkbox" name="pausado" ${c.pausado ? "checked" : ""} ${d.podeAdministrar ? "" : "disabled"}> <strong>Pausar todos os envios</strong> <small>(nenhum e-mail sai enquanto estiver ligado)</small></label>
                <p class="email_erro_form" hidden></p>
                ${d.podeAdministrar ? '<div class="email_modal_acoes"><button type="submit" class="email_btn email_btn_primario">Salvar controle</button></div>'
                    : '<p class="email_form_dica">Você pode ver, mas não alterar: falta a permissão <code>email.administrar</code>.</p>'}
                <p class="email_form_dica">Última alteração: ${c.alteradoEm ? `${esc(dh(c.alteradoEm))} por usuário #${esc(c.alteradoPor == null ? "?" : c.alteradoPor)}` : "nunca (valores padrão)"}.</p></form>`;

            corpo.innerHTML = `
                ${avisos}
                <p class="email_form_dica">Consumo = destinatários que o servidor SMTP aceitou (como a cota do AWS SES); falhas não contam. "Hoje" e "mês" no horário de Brasília. O limite vale para o módulo todo.</p>
                <div class="email_cards">
                    ${_medidor("Enviados hoje", d.diario, "Zera à meia-noite (Brasília)")}
                    ${_medidor("Enviados no mês", d.mensal, "Zera no dia 1º")}
                    <div class="email_card"><div class="email_card_rotulo">Última hora</div><div class="email_card_valor">${nBr(d.consumo.hora)}</div><div class="email_card_pct">destinatários aceitos</div></div>
                    <div class="email_card ${num(tx.percentual) >= 20 ? "email_faixa_alerta" : ""}"><div class="email_card_rotulo">Taxa de falha (${num(d.periodo)} dias)</div><div class="email_card_valor">${tx.percentual == null ? "—" : esc(String(tx.percentual).replace(".", ",")) + "%"}</div><div class="email_card_pct">${nBr(tx.falhas)} falha(s) em ${nBr(tx.finalizados)} mensagem(ns)</div></div>
                </div>

                <section class="email_secao"><h3>Controle de envio</h3>${controle}</section>

                <section class="email_secao"><h3>Últimos ${num(d.periodo)} dias</h3>${_grafico(d.serie || [])}<div class="email_chips">${status}</div></section>

                <div class="email_duas">
                    <section class="email_secao"><h3>Por módulo (${num(d.periodo)} dias)</h3><table class="email_tabela"><thead><tr><th>Módulo</th><th class="email_n">Mensagens</th><th class="email_n">Aceitos</th><th class="email_n">Falhas</th></tr></thead><tbody>${modulos}</tbody></table></section>
                    <section class="email_secao"><h3>Últimos erros</h3><table class="email_tabela"><thead><tr><th>Quando</th><th>Módulo</th><th>Código</th><th>Referência</th></tr></thead><tbody>${erros}</tbody></table></section>
                </div>

                <div class="email_duas">
                    <section class="email_secao"><h3>Limites do config.cfg <small>(somente leitura)</small></h3>
                        <ul class="email_lista">
                            <li>Rate limit: ${nBr(rl.MaximoPorModulo)} envios por módulo e ${nBr(rl.MaximoGlobal)} no total a cada ${nBr(rl.JanelaSegundos)} s</li>
                            <li>Por mensagem: até ${nBr(lim.MaxDestinatarios)} destinatários, ${nBr(lim.MaxAnexos)} anexos (${esc(bytes(lim.MaxAnexoBytes))} cada, ${esc(bytes(lim.MaxTotalAnexosBytes))} no total)</li>
                            <li>Servidor de envio: ${esc(smtp.modo)} — ${smtp.configurado ? "configurado" : "<strong>SEM credenciais completas</strong>"}</li>
                            <li>Módulos autorizados: ${esc((cfg.modulosPermitidos || []).join(", ") || "(nenhum)")}</li>
                        </ul><p class="email_form_dica">Para mudar estes valores edite o config.cfg e reinicie o módulo.</p></section>
                    <section class="email_secao"><h3>Alterações de limite</h3><table class="email_tabela"><thead><tr><th>Quando</th><th>Item</th><th>Mudança</th><th>Quem</th></tr></thead><tbody>${hist}</tbody></table></section>
                </div>
                <p class="email_form_dica">Gerado em ${esc(dh(d.geradoEm))} (Brasília).</p>`;

            const form = corpo.querySelector(".email_controle");
            if (d.podeAdministrar) form.addEventListener("submit", (e) => { e.preventDefault(); _salvarControle(form, c, recarregar); });
        }

        function _salvarControle(form, atual, recarregar) {
            const erro = form.querySelector(".email_erro_form");
            const falha = (t) => { erro.textContent = t; erro.hidden = false; };
            erro.hidden = true;
            const ler = (nome, rotulo, min, max) => {
                const t = String(form[nome].value).trim();
                if (!/^\d{1,9}$/.test(t)) { falha(`${rotulo}: informe um número inteiro (somente dígitos).`); return null; }
                const n = Number(t);
                if (n < min || n > max) { falha(`${rotulo}: use um valor entre ${nBr(min)} e ${nBr(max)}.`); return null; }
                return n;
            };
            const limiteDiario = ler("limiteDiario", "Limite diário", 0, 1000000); if (limiteDiario === null) return;
            const limiteMensal = ler("limiteMensal", "Limite mensal", 0, 10000000); if (limiteMensal === null) return;
            const percentualAlerta = ler("percentualAlerta", "Alerta", 1, 100); if (percentualAlerta === null) return;
            if (limiteDiario > 0 && limiteMensal > 0 && limiteDiario > limiteMensal) { falha("O limite diário não pode ser maior que o mensal."); return; }
            const pausado = form.pausado.checked;

            const enviar = () => chamar("email/controle/salvar", { limiteDiario, limiteMensal, percentualAlerta, pausado }, (r) => {
                if (r.status !== "OK") { falha(r.mensagem || "Não foi possível salvar."); return; }
                _LogAtividades.Registrar(r.dados.alterados.length ? `E-mail: controle alterado (${r.dados.alterados.join(", ")})` : "E-mail: controle salvo sem mudanças", "info");
                aviso(r.dados.alterados.length ? "Controle de envio salvo." : "Nada mudou.", "E-mail");
                recarregar();
            });
            if (pausado && !atual.pausado) confirmar("Pausar todos os envios?", "Enquanto a pausa estiver ligada, nenhum módulo consegue enviar e-mail (os pedidos voltam com o código \"pausado\").", "Pausar", enviar);
            else if (!pausado && atual.pausado) confirmar("Retomar os envios?", "Os módulos voltam a poder enviar e-mails, respeitando os limites.", "Retomar", enviar);
            else enviar();
        }
    })();
}
