# Carteira JGP

Dashboard de risco e retorno para a carteira: XLK 20% (long), XLE 15% (long),
EWZ 10% (long), XLY 10% (**short**), GLD 10% (long), 35% caixa.

Composição, matriz de correlação, performance histórica, simulador Markowitz
com fronteira eficiente, CAPM (beta/alpha vs. S&P 500) e métricas agregadas
(Sharpe, VaR, contribuição ao risco). Ferramenta educacional/analítica — não
constitui recomendação de investimento.

**Site:** https://rodrigomambrini.github.io/carteirajgp/

## Como funciona

Sem backend, sem chave de API. `scripts/fetch_and_compute.py` roda no
GitHub Actions (`.github/workflows/update-data.yml`, de hora em hora em
horário de mercado), busca preços no Yahoo Finance e o CDI no Banco Central,
calcula tudo (séries, CAPM, métricas da carteira) e escreve
`data/portfolio_data.json`, que o `index.html` só lê e renderiza.

## Rodar localmente

```bash
python scripts/fetch_and_compute.py   # gera/atualiza data/portfolio_data.json
python -m http.server 8124            # serve a pasta
```

Depois abra http://localhost:8124.

## Editar a alocação

Mude `data/portfolio.json` (pesos, long/short, capital de referência) e rode
o script de novo.

## Publicar no GitHub Pages

Settings → Pages → Deploy from branch → `main` / `/ (root)`.
