-- Controle de envio editável na tela (limite diário/mensal, % de alerta, pausa).
-- Uma linha por chave: limite_diario, limite_mensal, percentual_alerta, pausado ('1'/'0').
-- Chave ausente = padrão (sem limite, alerta 80%, sem pausa). Só números: nenhum segredo aqui.
CREATE TABLE IF NOT EXISTS _Core_Email_Configuracao (
  chave VARCHAR(40) NOT NULL PRIMARY KEY,
  valor VARCHAR(20) NOT NULL,
  alterado_por BIGINT NULL COMMENT 'id do usuário no Autenticador',
  alterado_em DATETIME(3) NOT NULL COMMENT 'horário de São Paulo'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Auditoria: toda alteração de limite/pausa (quem, quando, valor antes e depois).
CREATE TABLE IF NOT EXISTS _Core_Email_Configuracao_Historico (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  chave VARCHAR(40) NOT NULL,
  valor_antes VARCHAR(20) NULL,
  valor_depois VARCHAR(20) NULL,
  alterado_por BIGINT NULL,
  alterado_em DATETIME(3) NOT NULL,
  INDEX idx_core_email_cfg_hist (alterado_em)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
