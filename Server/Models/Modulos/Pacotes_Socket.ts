// Envelope oficial do TurboWS (ver TurboWS.md § API > Envelope interno).
// Nota: o WS-Mod_TurboGrowth tem uma cópia deste arquivo sem o campo `token` — divergência já
// registrada no TurboWS.md ("Há versões diferentes de Pacotes_Socket entre os repositórios").
// Aqui mantemos os 5 campos do envelope oficial para não repetir esse problema.
export interface Pacotes_Socket {
  evento: string;
  token: string;
  destino: string;
  origem: string;
  dados: string;
}
