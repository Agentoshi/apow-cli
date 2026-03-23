export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>APoW Dashboard</title>
<link rel="icon" type="image/png" sizes="32x32" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAFNUExURQAAAABS/wBS/wBS/wBS/wBS/wBS/wBS/wBS/wBS/wBS/wBS/wBS/wBS/wBS/wBS/wBS/wBS/wBS/wBS/wBR/xNf/32n/3ql/yFp/9zo/9rm/x9n/3ym/////3mk/wBQ/yFo/9fk//r8/6fD/6jE/wBP/+3z/zZ3/zh4/+7z/wRV/yds/yxw/0F+/73S/zJ0/77T/9jl/0B9/0yF/+Xt//D1//f5/0yG/wtZ/6G//+Tt/+vx/+zy/+Dq/+Lr/+rx/6LA/wNU/xpk/xxl/5K1/+3y/0uF/xpj/5G0/xtl/yNq/zl5/9jk/7nP/ypu/yRq/7rQ/yVr/8rb/+nw//7///P3/+fv/+jv/8vb/3um//H1/wJT/5i5/1OK/yht/1SL/+/0/5e5/x1l/9Xj/6PB/z17/z58//H2/wlY/3ai/5y8/3Ge/wZW/3Sg/569/+rqE9AAAAATdFJOUwAAAitvsNz0/jma4fwbjOw3xUOydetBAAAAAWJLR0Qd6wNxkQAAAAd0SU1FB+oDERUwG5vARuoAAAAldEVYdGRhdGU6Y3JlYXRlADIwMjYtMDMtMTdUMjE6NDg6MjIrMDA6MDDtKLHnAAAAJXRFWHRkYXRlOm1vZGlmeQAyMDI2LTAzLTE3VDIxOjQ4OjIyKzAwOjAwnHUJWwAAACh0RVh0ZGF0ZTp0aW1lc3RhbXAAMjAyNi0wMy0xN1QyMTo0ODoyNyswMDowMJlYByMAAAAZdEVYdFNvZnR3YXJlAEFkb2JlIEltYWdlUmVhZHlxyWU8AAABwklEQVQ4y4VTWVvCMBAM5T5FKKjAUkGpICoeXHKIgIrigQhe4AleKPr/H22btKT4fTgv3WYnk2R3FiERGgGMVqc3GE0mo0Gv0zLiClIgps0Wq81NYLNazAzFEEK7Y8qtwpTDrjCEwDnt/oNpJ2EIH5dBWWZZJTS4JIa4n8p7PBRD0hDOp/RZ7wxLnWIXCYyDys/O+fwUw8EIBDN1fzYAEOSot5g1iLFQ+XkfQIiWsDBIa1UJhMMqCasW6WwqgYVFlYRNh/RyzHGRAPBL0RgEI5wiokdyDZbjK6s+WEsk1mFjcyW+LNcCGcn+rSSfAkjzfBogxSczRMOITDjIbufyAIXizk6xAFDK7WbxukkmlCvVPdg/qFWrtQwPh0eVskwgR1TqxydwelZvNOpn5xCK1ivyEdIl2eZFq9CGy6trAVeX0C60bpocviR+5m2+A9BplSS0xDgfIM+UCtX1x+8gdt98kNB8fILnuL+LC4VLHen1YbfMEZRfoN+LkFLjZrFeSL0q5ePe3sHLkmbhdn8MPr+Gox4Nv38GH6TdsmEoM47+JMOoLDdmbMlyKtOqgE07Zns67xoNxsTB+X/0/h/eieP/CwWOXVaTpQ0oAAAAAElFTkSuQmCC">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0a0a;--card:#141414;--card-border:#161616;
  --text:#e5e5e5;--text-dim:#737373;--accent:#0052FF;
  --rarity-common:#a1a1aa;--rarity-uncommon:#4ade80;
  --rarity-rare:#60a5fa;--rarity-epic:#a78bfa;--rarity-mythic:#fbbf24;
}
body{background:var(--bg);color:var(--text);font-family:SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace;font-size:13px;line-height:1.4}
a{color:inherit;text-decoration:none}
.container{min-height:100vh;padding:12px}
/* Header */
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.header h1{font-size:14px;font-weight:700;letter-spacing:.05em}
.status{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-dim)}
.pulse{display:inline-block;height:6px;width:6px;border-radius:50%;background:var(--accent);animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
/* Banners */
.rpc-warning{border-radius:6px;border:1px solid #7c2d12;background:rgba(69,26,3,.3);padding:8px 12px;font-size:12px;color:#fdba74;margin-bottom:12px}
.rpc-warning a{text-decoration:underline}
.rpc-warning a:hover{color:#fed7aa}
.error-banner{border-radius:6px;border:1px solid #7f1d1d;background:rgba(69,10,10,.3);padding:8px 12px;font-size:12px;color:#f87171;margin-bottom:12px}
/* Fleet tabs */
.fleet-tabs{display:flex;align-items:center;gap:4px;margin-bottom:12px;overflow-x:auto}
.fleet-tab{padding:4px 12px;font-size:12px;border-radius:4px;cursor:pointer;white-space:nowrap;border:1px solid transparent;background:var(--card);color:var(--text-dim);transition:all .15s}
.fleet-tab:hover{color:var(--text)}
.fleet-tab.active{background:var(--accent);color:#fff;border-color:var(--accent)}
/* Stats grid */
.stats-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;background:var(--card-border);border-radius:8px;overflow:hidden;margin-bottom:12px}
@media(min-width:640px){.stats-grid{grid-template-columns:repeat(5,1fr)}}
@media(min-width:1024px){.stats-grid{grid-template-columns:repeat(12,1fr)}}
.stat-cell{background:var(--card);padding:8px 12px}
.stat-label{font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em}
.stat-value{font-size:14px;font-weight:600}
.stat-value.highlight{color:var(--accent)}
.stat-sub{font-size:10px;color:var(--text-dim)}
/* Wallet grid */
.wallet-grid{display:grid;grid-template-columns:1fr;gap:8px}
@media(min-width:640px){.wallet-grid{grid-template-columns:repeat(2,1fr)}}
@media(min-width:1024px){.wallet-grid{grid-template-columns:repeat(3,1fr)}}
@media(min-width:1280px){.wallet-grid{grid-template-columns:repeat(4,1fr)}}
.wallet-card{border-radius:6px;border:1px solid var(--card-border);background:var(--card);overflow:hidden}
.wallet-card.active{border-color:var(--accent)}
.wallet-header{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-bottom:1px solid var(--card-border)}
.wallet-addr{font-size:11px;font-weight:500;color:var(--text-dim);transition:color .15s}
.wallet-addr:hover{color:var(--accent)}
.wallet-stats{display:flex;align-items:center;gap:12px;font-size:11px}
.wallet-stats .hp{color:var(--rarity-uncommon)}
.wallet-stats .dim{color:var(--text-dim)}
.wallet-stats .agent-hl{color:var(--accent)}
.miners-wrap{display:flex;flex-wrap:wrap;gap:8px;padding:8px 10px}
.miner-thumb{display:flex;align-items:center;gap:4px;text-decoration:none}
.miner-thumb:hover .miner-img{box-shadow:0 0 0 1px var(--accent)}
.miner-thumb:hover .miner-id{color:var(--accent)}
.miner-img{height:40px;width:40px;border-radius:4px;transition:box-shadow .15s}
.miner-placeholder{height:40px;width:40px;border-radius:4px;background:rgba(255,255,255,.05);animation:pulse 1.5s infinite}
.miner-id{font-size:9px;color:var(--text-dim);transition:color .15s}
.no-miners{padding:8px 10px;font-size:10px;color:var(--text-dim)}
/* Empty state */
.empty-state{border-radius:6px;border:1px solid var(--card-border);background:var(--card);padding:16px 20px;font-size:12px;color:var(--text-dim)}
.empty-state h2{font-size:14px;color:var(--text);text-align:center;margin-bottom:12px}
.empty-state code{color:var(--accent)}
.empty-state .cmds{margin:8px 0 0 8px;line-height:2}
.empty-state .hint{margin-top:12px;font-size:10px}
/* Loading */
.loading{text-align:center;padding:80px 0;color:var(--text-dim)}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>APoW DASHBOARD</h1>
    <div class="status"><span class="pulse" id="statusDot"></span><span id="statusText">Loading...</span></div>
  </div>
  <div id="rpcWarning" class="rpc-warning" style="display:none">
    Using public Base RPC (mainnet.base.org) — this is unreliable for dashboards with many wallets.
    Get a free dedicated endpoint at <a href="https://www.alchemy.com/base" target="_blank" rel="noopener noreferrer">alchemy.com</a> for reliable data.
  </div>
  <div id="errorBanner" class="error-banner" style="display:none">Failed to fetch data. Check RPC connection.</div>
  <div id="fleetTabs" class="fleet-tabs" style="display:none"></div>
  <div id="statsGrid" class="stats-grid" style="display:none"></div>
  <div id="walletGrid" class="wallet-grid"></div>
  <div id="emptyState" class="empty-state" style="display:none">
    <h2>No wallets detected.</h2>
    <p>To add wallets:</p>
    <div class="cmds">
      <div><code>apow dashboard add &lt;address&gt;</code> <span>— add a specific address</span></div>
      <div><code>apow dashboard scan</code> <span>— auto-detect from wallet files in current dir</span></div>
    </div>
    <p class="hint">Wallets are also auto-detected from your .env PRIVATE_KEY on dashboard start.</p>
  </div>
  <div id="loading" class="loading">Loading...</div>
</div>
<script>
(function(){
  var activeFleet = 'All';
  var balanceHistory = [];
  var prevMines = {};
  var activeWallets = {};
  var lastSeen = {};
  var pollCount = 0;

  function fetchJson(url) {
    return fetch(url).then(function(r) {
      if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
      return r.json();
    });
  }

  function fmt(n, d) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: d !== undefined ? d : 1 }); }
  function fmtFixed(n, d) { return Number(n).toFixed(d); }

  function statCellHtml(label, value, opts) {
    opts = opts || {};
    var cls = 'stat-value' + (opts.highlight ? ' highlight' : '');
    var sub = opts.sub ? '<div class="stat-sub">' + opts.sub + '</div>' : '';
    return '<div class="stat-cell"><div class="stat-label">' + label + '</div><div class="' + cls + '">' + value + '</div>' + sub + '</div>';
  }

  function shortAddr(addr) { return addr.slice(0, 6) + '...' + addr.slice(-4); }

  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function updateMiningRate(totalAgent) {
    if (totalAgent <= 0) return { perMin: null, perHour: null, sessionGain: null, sessionMinutes: null };
    var now = Date.now();
    var h = balanceHistory;
    if (h.length === 0 || h[h.length - 1].agent !== totalAgent) {
      h.push({ agent: totalAgent, timestamp: now });
    }
    if (h.length > 120) h.splice(0, h.length - 120);
    if (h.length < 2) return { perMin: null, perHour: null, sessionGain: null, sessionMinutes: null };
    var first = h[0], last = h[h.length - 1];
    var elapsedMin = (last.timestamp - first.timestamp) / 60000;
    if (elapsedMin < 0.5) return { perMin: null, perHour: null, sessionGain: null, sessionMinutes: null };
    var gained = last.agent - first.agent;
    var perMin = gained / elapsedMin;
    return { perMin: perMin, perHour: perMin * 60, sessionGain: gained, sessionMinutes: Math.floor(elapsedMin) };
  }

  function updateActiveWallets(wallets) {
    if (!wallets) return;
    pollCount++;
    // Skip first 2 polls to establish stable baseline (avoids false positives on load/refresh)
    if (pollCount <= 2) {
      for (var i = 0; i < wallets.length; i++) {
        var w = wallets[i];
        var totalMines = 0;
        for (var j = 0; j < w.miners.length; j++) totalMines += Number(w.miners[j].mineCount);
        prevMines[w.address] = totalMines;
      }
      return;
    }
    var now = Date.now();
    for (var i = 0; i < wallets.length; i++) {
      var w = wallets[i];
      var totalMines = 0;
      for (var j = 0; j < w.miners.length; j++) totalMines += Number(w.miners[j].mineCount);
      var prev = prevMines[w.address];
      if (prev !== undefined && totalMines > prev) {
        activeWallets[w.address] = true;
        lastSeen[w.address] = now;
      }
      if (lastSeen[w.address] && now - lastSeen[w.address] > 300000) {
        delete activeWallets[w.address];
      }
      prevMines[w.address] = totalMines;
    }
  }

  function renderFleetTabs(fleets) {
    var el = document.getElementById('fleetTabs');
    if (!fleets || fleets.length <= 1) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    var totalCount = 0;
    for (var i = 0; i < fleets.length; i++) totalCount += fleets[i].walletCount;
    var html = '<div class="fleet-tab' + (activeFleet === 'All' ? ' active' : '') + '" data-fleet="All">All (' + totalCount + ')</div>';
    for (var i = 0; i < fleets.length; i++) {
      var f = fleets[i];
      html += '<div class="fleet-tab' + (activeFleet === f.name ? ' active' : '') + '" data-fleet="' + escapeHtml(f.name) + '">' + escapeHtml(f.name) + ' (' + f.walletCount + ')</div>';
    }
    el.innerHTML = html;
    var tabs = el.querySelectorAll('.fleet-tab');
    for (var t = 0; t < tabs.length; t++) {
      tabs[t].addEventListener('click', function() {
        activeFleet = this.getAttribute('data-fleet');
        refresh();
      });
    }
  }

  function renderStats(wallets, network) {
    var el = document.getElementById('statsGrid');
    if (!wallets && !network) { el.style.display = 'none'; return; }
    el.style.display = 'grid';
    var totalAgent = 0, totalEth = 0, totalMiners = 0, totalHashpower = 0;
    if (wallets) {
      for (var i = 0; i < wallets.length; i++) {
        totalAgent += Number(wallets[i].agentBalance);
        totalEth += Number(wallets[i].ethBalance);
        totalMiners += wallets[i].miners.length;
        for (var j = 0; j < wallets[i].miners.length; j++) totalHashpower += wallets[i].miners[j].hashpower;
      }
    }
    var rate = updateMiningRate(totalAgent);
    var html = '';
    html += statCellHtml('TOTAL AGENT', fmt(totalAgent, 1), { highlight: true });
    html += statCellHtml('TOTAL ETH', fmtFixed(totalEth, 4));
    html += statCellHtml('WALLETS', wallets ? String(wallets.length) : '\\u2014');
    html += statCellHtml('MINERS', String(totalMiners));
    html += statCellHtml('HASHPOWER', fmtFixed(totalHashpower / 100, 1) + 'x');
    html += statCellHtml('AGENT/MIN', rate.perMin !== null ? fmtFixed(rate.perMin, 2) : '\\u2014', { highlight: rate.perMin !== null && rate.perMin > 0 });
    html += statCellHtml('AGENT/HR', rate.perHour !== null ? fmtFixed(rate.perHour, 1) : '\\u2014', {
      highlight: rate.perHour !== null && rate.perHour > 0,
      sub: rate.sessionGain !== null ? '+' + fmtFixed(rate.sessionGain, 1) + ' in ' + rate.sessionMinutes + 'm' : undefined
    });
    if (network) {
      html += statCellHtml('ERA', String(network.era), { sub: fmt(network.minesUntilNextEra, 0) + ' to next' });
      html += statCellHtml('BASE REWARD', fmtFixed(network.baseReward, 2) + ' AGENT/mine');
      html += statCellHtml('SUPPLY', fmtFixed(network.supplyPct, 2) + '%');
      html += statCellHtml('DIFFICULTY', String(network.difficulty));
      html += statCellHtml('NETWORK MINES', fmt(network.totalMines, 0));
    }
    el.innerHTML = html;
  }

  function renderWallets(wallets) {
    var grid = document.getElementById('walletGrid');
    var empty = document.getElementById('emptyState');
    if (!wallets || wallets.length === 0) {
      grid.innerHTML = '';
      if (wallets) empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    wallets = wallets.slice().sort(function(a, b) { return Number(b.agentBalance) - Number(a.agentBalance); });
    var html = '';
    for (var i = 0; i < wallets.length; i++) {
      var w = wallets[i];
      var isActive = !!activeWallets[w.address];
      var hasAgent = Number(w.agentBalance) > 0;
      var walletHp = 0;
      for (var j = 0; j < w.miners.length; j++) walletHp += w.miners[j].hashpower;
      html += '<div class="wallet-card' + (isActive ? ' active' : '') + '">';
      html += '<div class="wallet-header">';
      html += '<a class="wallet-addr" href="https://basescan.org/address/' + w.address + '" target="_blank" rel="noopener noreferrer">' + shortAddr(w.address) + '</a>';
      html += '<div class="wallet-stats">';
      if (w.miners.length > 0) html += '<span class="hp">' + fmtFixed(walletHp / 100, 1) + 'x</span>';
      html += '<span><span class="dim">E </span>' + fmtFixed(Number(w.ethBalance), 4) + '</span>';
      html += '<span' + (hasAgent ? ' class="agent-hl"' : '') + '><span class="dim">A </span>' + fmt(Number(w.agentBalance), 1) + '</span>';
      html += '</div></div>';
      if (w.miners.length > 0) {
        html += '<div class="miners-wrap">';
        for (var j = 0; j < w.miners.length; j++) {
          var m = w.miners[j];
          var osUrl = 'https://opensea.io/item/base/0xb7cad3ca5f2bd8aec2eb67d6e8d448099b3bc03d/' + m.tokenId;
          html += '<a class="miner-thumb" href="' + osUrl + '" target="_blank" rel="noopener noreferrer">';
          if (m.imageUri) {
            html += '<img class="miner-img" src="' + escapeHtml(m.imageUri) + '" alt="#' + m.tokenId + '">';
          } else {
            html += '<div class="miner-placeholder"></div>';
          }
          html += '<span class="miner-id">#' + m.tokenId + '</span></a>';
        }
        html += '</div>';
      } else {
        html += '<div class="no-miners">No miners</div>';
      }
      html += '</div>';
    }
    grid.innerHTML = html;
  }

  var networkData = null;
  var walletsData = null;
  var hasError = false;

  function setStatus(refreshing) {
    document.getElementById('statusDot').style.display = refreshing ? 'inline-block' : 'none';
    document.getElementById('statusText').textContent = refreshing ? 'Refreshing...' : 'Live';
  }

  function refresh() {
    setStatus(true);
    var fleetParam = encodeURIComponent(activeFleet);
    Promise.all([
      fetchJson('/api/network').catch(function(e) { return null; }),
      fetchJson('/api/wallets?fleet=' + fleetParam).catch(function(e) { return null; }),
      fetchJson('/api/fleets').catch(function(e) { return null; }),
      fetchJson('/api/config').catch(function(e) { return null; })
    ]).then(function(results) {
      document.getElementById('loading').style.display = 'none';
      var net = results[0], wal = results[1], fleets = results[2], cfg = results[3];
      hasError = !net && !wal;
      document.getElementById('errorBanner').style.display = hasError ? 'block' : 'none';
      if (net) networkData = net;
      if (wal && !wal.error) {
        walletsData = wal;
        updateActiveWallets(wal);
      }
      if (cfg) {
        document.getElementById('rpcWarning').style.display = cfg.rpcIsDefault ? 'block' : 'none';
      }
      renderFleetTabs(fleets);
      renderStats(walletsData, networkData);
      renderWallets(walletsData);
      setStatus(false);
    }).catch(function() {
      document.getElementById('loading').style.display = 'none';
      document.getElementById('errorBanner').style.display = 'block';
      setStatus(false);
    });
  }

  refresh();
  setInterval(refresh, 30000);
})();
</script>
</body>
</html>`;
}
