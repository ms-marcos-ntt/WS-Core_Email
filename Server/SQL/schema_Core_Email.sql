-- Log de envios do WS-Core_Email. Uma linha por pedido que chegou a tentar o envio.
-- Datas em horário de São Paulo (gravadas pelo módulo; ver Relogio_Email.ts).
-- Nunca guarda o corpo da mensagem, anexos nem credenciais; `erro` já vem sem segredos.
CREATE TABLE IF NOT EXISTS _Core_Email_Envios (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  criado_em DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  concluido_em DATETIME(3) NULL,
  solicitante_modulo VARCHAR(100) NOT NULL COMMENT 'Modulo_Nome do módulo que pediu o envio',
  usuario_id BIGINT NULL COMMENT 'Usuário do token, só quando Autorizacao.ExigirPermissaoUsuario está ligado',
  referencia VARCHAR(120) NULL COMMENT 'Texto livre do solicitante (ex.: fibramap:pre_viabilidade:123)',
  para TEXT NOT NULL,
  cc TEXT NULL,
  bcc TEXT NULL,
  assunto VARCHAR(255) NOT NULL,
  template VARCHAR(64) NULL,
  qtd_anexos TINYINT UNSIGNED NOT NULL DEFAULT 0,
  tamanho_bytes INT UNSIGNED NOT NULL DEFAULT 0,
  qtd_destinatarios INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'para+cc+bcc do pedido',
  qtd_aceitos INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'destinatários aceitos pelo servidor SMTP (é o que consome a cota)',
  transporte VARCHAR(20) NOT NULL,
  status ENUM('enviando','enviado','falhou') NOT NULL DEFAULT 'enviando',
  message_id VARCHAR(255) NULL,
  erro_codigo VARCHAR(30) NULL,
  erro TEXT NULL,
  INDEX idx_core_email_criado (criado_em),
  INDEX idx_core_email_modulo (solicitante_modulo, criado_em),
  INDEX idx_core_email_status (status, criado_em)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
