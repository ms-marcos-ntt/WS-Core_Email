-- Permissões e menu da tela do WS-Core_Email (histórico, uso e limites). Idempotente: roda a cada
-- inicialização/`npm run setup`; as tabelas _Permissoes e _Menus não têm UNIQUE, por isso WHERE NOT EXISTS.
--
-- ATENÇÃO: `_Menus.modulo` precisa ser EXATAMENTE o nome com que o módulo se registra no Core
-- (modulo.nome do config.cfg = WSCore_Email). Qualquer outro valor faz o Core marcar o menu como
-- "módulo desligado" (bug já ocorrido no FibraMap). Os UPDATEs abaixo corrigem linhas antigas.

INSERT INTO _Permissoes (codigo, nome, descricao, modulo)
SELECT 'email.visualizar', 'E-mail Visualizar', 'Ver o histórico de envios, o uso e os limites do módulo de e-mail', 'WSCore_Email' FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM _Permissoes WHERE codigo = 'email.visualizar');

INSERT INTO _Permissoes (codigo, nome, descricao, modulo)
SELECT 'email.administrar', 'E-mail Administrar', 'Alterar limites de envio (diário/mensal/alerta) e pausar os envios', 'WSCore_Email' FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM _Permissoes WHERE codigo = 'email.administrar');

INSERT INTO _Menus (codigo, nome, descricao, menu_pai, versao, permissao, modulo, evento, load_dependencia, configuracao)
SELECT 'email', 'E-mail', 'Envio de e-mails do sistema', '', '1', 'email.visualizar', 'WSCore_Email', '', '', '{"menu_icon":"mail"}' FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM _Menus WHERE codigo = 'email');

INSERT INTO _Menus (codigo, nome, descricao, menu_pai, versao, permissao, modulo, evento, load_dependencia, configuracao)
SELECT 'email/historico', 'Histórico de envios', 'Todos os e-mails enviados (ou que falharam), com filtros e detalhe', 'email', '1', 'email.visualizar', 'WSCore_Email', 'open/email/historico', './modulos/WSCore_Email/js/Email.js', '{"menu_icon":"history"}' FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM _Menus WHERE codigo = 'email/historico');

INSERT INTO _Menus (codigo, nome, descricao, menu_pai, versao, permissao, modulo, evento, load_dependencia, configuracao)
SELECT 'email/uso', 'Uso e limites', 'Consumo do dia/mês, limites, pausa e erros recentes', 'email', '1', 'email.visualizar', 'WSCore_Email', 'open/email/uso', './modulos/WSCore_Email/js/Email.js', '{"menu_icon":"speed"}' FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM _Menus WHERE codigo = 'email/uso');

UPDATE _Menus SET modulo = 'WSCore_Email' WHERE codigo IN ('email', 'email/historico', 'email/uso');
