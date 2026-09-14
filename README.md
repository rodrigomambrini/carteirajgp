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
intradiárias no Yahoo Finance mais o CDI no Banco Central, calcula as séries
e o CAPM, e escreve `data/portfolio_data.json` — que a página lê a cada F5.

O navegador não consegue chamar o Yahoo direto (a API deles não envia
cabeçalhos CORS) e proxies públicos são bloqueados por rate limit em poucos
minutos, por isso o fetch acontece do lado do servidor. Para preços live a
cada F5 seria preciso um proxy próprio (ex.: Cloudflare Worker).

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
