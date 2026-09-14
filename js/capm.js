/*
 * CAPM table + beta bar chart. The regression itself lives in js/stats.js
 * (computeCapmFor), so these numbers are recomputed from the close arrays on
 * every load — including after live quotes patch them. This file only renders
 * whatever is currently in data.assets[sym].capm.
 */

let capmChart = null;

function renderCapm(data) {
  const rows = ASSET_ORDER.map(sym => {
    const c = data.assets[sym].capm;
    const beat = c.realized_return_pct >= c.expected_capm_pct;
    return `<tr>
      <td class="asset-name-cell"><span class="asset-dot" style="background:${accentColor(sym)}"></span>${sym}</td>
      <td class="num">${fmtNum(c.beta, 2)}</td>
      <td class="num">${fmtPct(c.alpha_annual_pct)}</td>
      <td class="num">${fmtPct(c.expected_capm_pct)}</td>
      <td class="num ${beat ? "beat" : "miss"}">${fmtPct(c.realized_return_pct)}</td>
    </tr>`;
  }).join("");

  document.getElementById("capm-table").innerHTML = `
    <thead><tr><th>Posição</th><th>Beta</th><th>Alpha</th><th>Expectativa CAPM</th><th>Retorno real</th></tr></thead>
    <tbody>${rows}</tbody>
  `;

  // Destroy before recreating: renderCapm runs again when live quotes arrive,
  // and Chart.js refuses to reuse a canvas that still owns a chart.
  if (capmChart) capmChart.destroy();
  capmChart = new Chart(document.getElementById("chart-capm-beta").getContext("2d"), {
    type: "bar",
    data: {
      labels: ASSET_ORDER,
      datasets: [{ data: ASSET_ORDER.map(sym => data.assets[sym].capm.beta), backgroundColor: ASSET_ORDER.map(sym => accentColor(sym)) }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: cssVar("--surface"), titleColor: cssVar("--text-primary"), bodyColor: cssVar("--text-secondary"), borderColor: cssVar("--border-strong"), borderWidth: 1 },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: cssVar("--text-secondary"), font: { family: "IBM Plex Mono", size: 11 } } },
        y: { grid: { color: cssVar("--grid") }, ticks: { color: cssVar("--text-muted"), font: { family: "IBM Plex Mono", size: 10 } } },
      },
    },
  });
}
