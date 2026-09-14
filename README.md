# Carteira JGP

Dashboard interativo de risco e retorno para uma carteira de **$100M**:
XLK 30% (long), XLE 20% (long), EWZ 10% (long), XLY 10% (**short**),
GLD 15% (long) e 15% em caixa.

Composição, matriz de correlação, performance histórica (preços reais em
USD), CAPM (beta/alpha vs. S&P 500) e métricas agregadas — Sharpe, VaR,
contribuição ao risco. Ferramenta educacional/analítica, não constitui
recomendação de investimento.

**Site:** https://rodrigomambrini.github.io/carteirajgp/

## Interativo

Cada peso é independente: mexer em um não mexe nos outros, e o caixa absorve
a diferença para fechar 100%. Cada posição tem slider, input numérico e um
botão LONG/SHORT. Composição, correlação, a linha "Carteira" nos gráficos,
métricas e análise recalculam ao vivo no navegador.

## Como funciona

Sem backend e sem chave de API. `scripts/fetch_and_compute.py` roda no GitHub
Actions a cada 15 minutos em horário de mercado, busca preços e cotações
intradiárias no Yahoo Finance mais o CDI no Banco Central, e escreve
`data/portfolio_data.json` — que a página lê a cada F5.

O script é só um coletor: ele grava `dates`, `close` e a cotação do dia. Todo
o resto (drawdown, volatilidade e Sharpe rolantes, covariância, correlação,
CAPM e as métricas da carteira) é calculado no navegador por `js/stats.js`, a
partir dos mesmos arrays. É isso que permite recalcular tudo quando chega um
preço ao vivo, sem ter duas implementações da mesma conta.

## Preços live via Cloudflare Worker

Por padrão os preços vêm do JSON do Actions (até ~15 min de defasagem). Para
ter preço ao vivo a cada F5, suba o Worker — o navegador não consegue chamar
o Yahoo direto, porque a API deles não envia cabeçalhos CORS, e proxies
públicos bloqueiam por rate limit em poucos minutos.

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

O wrangler imprime a URL (`https://carteirajgp-yahoo-proxy.<você>.workers.dev`).
Cole ela em `js/config.js`:

```js
const LIVE_PROXY_URL = "https://carteirajgp-yahoo-proxy.seu-usuario.workers.dev";
```

Faça commit e pronto. O cabeçalho passa a mostrar **● ao vivo** com o horário
da cotação. O Worker é grátis no plano free da Cloudflare (100k requisições/dia),
só aceita os 6 tickers da carteira — não é um proxy aberto — e guarda cache de
60s para não esbarrar em rate limit do Yahoo.

Se a URL ficar vazia, ou o Worker cair, a página continua funcionando com os
preços do Actions e avisa no cabeçalho. Nada quebra.

## Rodar localmente

```bash
python scripts/fetch_and_compute.py   # atualiza data/portfolio_data.json
python -m http.server 8124            # serve a pasta
```

Depois abra http://localhost:8124.

## Editar a carteira

Mude `data/portfolio.json` — `capital_usd`, `positions` (peso e long/short) e
`lots` (as ordens individuais, com preço de disparo e status). Todo o resto
deriva dele.

## Publicar no GitHub Pages

Settings → Pages → Deploy from branch → `main` / `/ (root)`.
