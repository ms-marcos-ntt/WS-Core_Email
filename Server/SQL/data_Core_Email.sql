-- Permissão no Autenticador (tabela _Permissoes). Só é exigida se Autorizacao.ExigirPermissaoUsuario = true.
-- Idempotente (a tabela não tem UNIQUE em `codigo`, por isso o WHERE NOT EXISTS).
INSERT INTO _Permissoes (codigo, nome, descricao, modulo)
SELECT 'email.enviar', 'E-mail Enviar', 'Pedir o envio de e-mails pelo módulo WSCore_Email', 'WSCore_Email' FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM _Permissoes WHERE codigo = 'email.enviar');
