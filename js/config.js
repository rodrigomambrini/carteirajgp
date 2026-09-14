/*
 * Endereço do Cloudflare Worker que serve as cotações live.
 *
 * Enquanto estiver vazio, o dashboard funciona normalmente com os preços do
 * GitHub Actions (atualizados a cada 15 min) — nada quebra. Depois de rodar
 * `npx wrangler deploy` dentro de worker/, cole aqui a URL que o wrangler
 * imprimir e faça commit: a partir daí cada F5 busca preço ao vivo, com
 * fallback automático para o JSON se o Worker estiver fora do ar.
 *
 * Exemplo:
 *   const LIVE_PROXY_URL = "https://carteirajgp-yahoo-proxy.seu-usuario.workers.dev";
 */

const LIVE_PROXY_URL = "";

// Quanto tempo esperar pelo Worker antes de desistir e usar o JSON commitado.
// Curto de propósito: a página já renderizou com os dados do Actions quando
// esta requisição sai, então uma espera longa só atrasaria a atualização.
const LIVE_TIMEOUT_MS = 5000;
