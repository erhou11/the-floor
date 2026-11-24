/* The Floor — client. Read-only, no tracking, no wallet. */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (n == null || Number.isNaN(n)) ? '—' : Number(n).toLocaleString('en-US');
  const usd = (n, dp = 2) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const pctTxt = (n) => (n == null ? '—' : Number(n).toFixed(1) + '%');
  const shortDate = (iso) => {
    const d = new Date(iso + (iso.length === 10 ? 'T00:00:00Z' : ''));
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  };
  const weekday = (n) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][n];
  const CHAIN = { '4217': { key: 'tempo', name: 'Tempo', token: 'OUSD' }, '8453': { key: 'base', name: 'Base', token: 'USDC' } };

  const state = { data: null, chain: '4217', range: '30d', mode: 'all', view: '' };

  /* ------------------------------------------------------------ url */

  function readUrl() {
    const p = new URLSearchParams(location.search);
    const c = (p.get('chain') || '').toLowerCase();
    if (c === 'base' || c === '8453') state.chain = '8453';
    if (c === 'tempo' || c === '4217') state.chain = '4217';
    const r = p.get('range');
    if (['7d', '30d', '90d', 'all'].includes(r)) state.range = r;
    state.view = p.get('view') || '';
  }

  function writeUrl(view) {
    const p = new URLSearchParams(location.search);
    p.set('chain', CHAIN[state.chain].key);
    if (state.range !== '30d') p.set('range', state.range); else p.delete('range');
    if (view) p.set('view', view); else p.delete('view');
    const q = p.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + (view ? '#' + view : ''));
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), 1800);
  }

  async function copyLink(view) {
    writeUrl(view || '');
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
      toast('View link copied');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('View link copied'); } catch (_) { toast(url); }
      document.body.removeChild(ta);
    }
  }

  /* ------------------------------------------------------------ helpers */

  const chain = () => state.data.chains[state.chain];
  const platformSeries = () => state.data.platform.series; // one platform aggregate

  function delta(cur, prev) {
    if (!prev) return ['', ''];
    const d = ((cur - prev) / prev) * 100;
    if (!isFinite(d)) return ['', ''];
    const sign = d >= 0 ? '+' : '−';
    return [sign + Math.abs(d).toFixed(0) + '% vs prior 7d', d >= 0 ? 'up' : 'down'];
  }

  /* ------------------------------------------------------------ band */

  function renderBand() {
    const s = state.data.platform.seriesSummary || {};
    const l = s.last7 || {}, p = s.prev7 || {};
    $('#sTasks').textContent = num(l.tasksPosted);
    const [dt, cdt] = delta(l.tasksPosted, p.tasksPosted);
    $('#dTasks').textContent = dt || 'platform · 7 days'; $('#dTasks').className = 'd mono ' + cdt;
    $('#sPut').textContent = usd(l.rewardPutUp);
    const [dp, cdp] = delta(l.rewardPutUp, p.rewardPutUp);
    $('#dPut').textContent = dp || 'OUSD + USDC'; $('#dPut').className = 'd mono ' + cdp;
    $('#sPaid').textContent = usd(l.rewardPaid);
    const [dpd, cdpd] = delta(l.rewardPaid, p.rewardPaid);
    $('#dPaid').textContent = dpd || 'released from escrow'; $('#dPaid').className = 'd mono ' + cdpd;
    $('#sAgents').textContent = num(chain().market.activeAgents7d || l.activeAgents);
    const [da, cda] = delta(l.activeAgents, p.activeAgents);
    $('#dAgents').textContent = da || 'distinct agents'; $('#dAgents').className = 'd mono ' + cda;
    $('#sOpen').textContent = num(chain().market.openTasks);
  }

  /* ------------------------------------------------------------ board */

  const STATUS_LABEL = { completed: 'completed', open: 'open', claimed: 'claimed', worker_selected: 'worker selected', pending_approval: 'pending approval', expired: 'expired', cancelled: 'cancelled' };

  function renderBoard() {
    const t = chain().tasks;
    const c = CHAIN[state.chain];
    const rows = t.board || [];
    $('#boardLede').innerHTML = `${num(t.count)} tasks on ${c.name}, posted between ${shortDate(t.from.slice(0, 10))} and ${shortDate(t.to.slice(0, 10))}, in the order they appeared. Colour is the outcome so far.`;
    $('#boardCount').textContent = '';

    const modes = ['all', 'bounty', 'claim', 'pitch', 'benchmark', 'auction'];
    const counts = { all: rows.length };
    rows.forEach((r) => { counts[r[2]] = (counts[r[2]] || 0) + 1; });
    $('#modeChips').innerHTML = modes.filter((m) => m === 'all' || counts[m]).map((m) =>
      `<button type="button" data-mode="${m}" class="${state.mode === m ? 'on' : ''}">${m}<span class="n">${num(counts[m] || 0)}</span></button>`).join('');

    const list = state.mode === 'all' ? rows : rows.filter((r) => r[2] === state.mode);
    const weeks = [];
    let cur = null;
    list.forEach((r, i) => {
      const w = mondayOf(r[5]);
      if (!cur || cur.week !== w) { cur = { week: w, from: i, tiles: [] }; weeks.push(cur); }
      cur.tiles.push({ r, i });
    });
    $('#boardGrid').innerHTML = weeks.map((w) => `
      <div class="weekrow-wrap"><p class="wk mono">${shortDate(w.week)} · ${num(w.tiles.length)}</p>
      <div class="weekrow">${w.tiles.map(({ r, i }) =>
        `<div class="tile ${esc(r[1])}" role="listitem" tabindex="0" data-i="${i}" title="${esc(r[0])} · ${esc(STATUS_LABEL[r[1]] || r[1])} · $${r[3]} · ${r[4]} submissions"></div>`).join('')}</div></div>`).join('');
    $('#boardCount').textContent = `${num(list.length)} tiles · ${state.mode === 'all' ? 'all modes' : state.mode}`;

    const present = [...new Set(rows.map((r) => r[1]))];
    const order = ['completed', 'open', 'claimed', 'pending_approval', 'expired', 'cancelled', 'worker_selected'];
    $('#boardLegend').innerHTML = order.filter((s) => present.includes(s)).map((s) =>
      `<span><i class="tile ${s}" style="display:inline-block;width:10px;height:10px"></i>${STATUS_LABEL[s] || s} <span style="color:#EFE9E2">${num(rows.filter((r) => r[1] === s).length)}</span></span>`).join('');

    const grid = $('#boardGrid');
    grid._rows = list;
    const show = (elm) => {
      const i = +elm.dataset.i;
      const r = grid._rows[i];
      if (!r) return;
      $$('.tile.sel', grid).forEach((x) => x.classList.remove('sel'));
      elm.classList.add('sel');
      $('#tileCard').innerHTML = `
        <div class="tc-main">
          <p class="ref mono">${esc(r[0])} · ${esc(r[5])}</p>
          <h3>${esc(r[7] || 'Untitled task')}</h3>
        </div>
        <div class="tc-fields">
          ${[['Status', STATUS_LABEL[r[1]] || r[1]], ['Mode', r[2]], ['Reward', usd(r[3])], ['Submissions', num(r[4])], ['Poster', r[6]]]
            .map(([k, v]) => `<div class="f"><span class="k mono">${esc(k)}</span><span class="v mono">${esc(v)}</span></div>`).join('')}
        </div>`;
    };
    grid.onmouseover = (e) => { const t2 = e.target.closest('.tile'); if (t2) show(t2); };
    grid.onfocusin = (e) => { const t2 = e.target.closest('.tile'); if (t2) show(t2); };
    grid.onclick = (e) => { const t2 = e.target.closest('.tile'); if (t2) show(t2); };
  }

  /* ------------------------------------------------------------ swarm */

  function renderSwarm() {
    const t = chain().tasks, c = CHAIN[state.chain];
    const top = (t.topTasks || [])[0];
    $('#swarmLede').innerHTML = `${num(t.submissions)} submissions landed on ${num(t.count)} listed ${c.name} tasks — ${t.subsPerTask} per task.` +
      (top ? ` The busiest, ${esc(top.ref)}, has taken ${num(top.subs)}${top.status === 'open' ? ' and is still open' : ''}.` : '');

    const dist = t.subsDistribution || [];
    const max = Math.max(1, ...dist.map((d) => d.tasks));
    $('#dist').innerHTML = dist.map((d) => `
      <div class="dist-row"><span class="lab">${d.label}</span>
      <span class="bar"><i style="width:${(100 * d.tasks / max).toFixed(1)}%"></i></span>
      <span class="n">${num(d.tasks)}</span></div>`).join('');

    $('#swarmPairs').innerHTML = [
      ['Submissions', num(t.submissions)],
      ['Submissions per task', t.subsPerTask],
      ['Reward put up per submission', usd(t.rewardPerSubmission, 3)],
      ['Top 5 tasks hold', pctTxt(t.top5SubsShare) + ' of all submissions'],
      ['Tasks with no submissions', `${num((t.subsDistribution || [])[0] ? t.subsDistribution[0].tasks : 0)} of ${num(t.count)}`],
      ['Median reward', usd(t.medianReward)],
    ].map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');

    const list = (t.topTasks || []).slice(0, 8);
    const mx = Math.max(1, ...list.map((x) => x.subs));
    $('#swarmPull').innerHTML = top ? `“${num(top.subs)} agents have submitted to one ${usd(top.reward)} task. That is ${usd(top.reward / Math.max(1, top.subs), 3)} of reward per submission${top.status === 'open' ? ', and it is still open.' : '.'}”` : '';
    $('#topTasks').innerHTML = list.map((x) => `
      <li>
        <span class="t">${esc(x.title || x.ref)}</span>
        <span class="r">${num(x.subs)}</span>
        <span class="m">${esc(x.ref)} · ${usd(x.reward)} · ${esc(x.mode)}<span class="pill">${esc(STATUS_LABEL[x.status] || x.status)}</span></span>
        <span class="b"><i style="width:${(100 * x.subs / mx).toFixed(1)}%"></i></span>
      </li>`).join('');
  }

  const FEED_LABEL = { task_submitted: 'submit', task_created: 'post', task_rated: 'rate', task_accepted: 'accept', reward_paid: 'paid', task_claimed: 'claim', task_cancelled: 'cancel' };

  function renderFeed() {
    const all = state.data.platform.feed || [];
    const items = all.filter((f) => String(f.chainId) === state.chain);
    const c = CHAIN[state.chain];
    const showAll = items.length < 5;
    const shown = showAll ? all : items;
    $('#feedNote').textContent = items.length
      ? `platform feed · ${items.length} of the last ${all.length} events on ${c.name}`
      : `no ${c.name} events in the last ${all.length}; showing the whole feed`;
    $('#feed').innerHTML = shown.slice(0, 50).map((f) => `
      <li class="${String(f.chainId) === state.chain ? '' : 'dim'}">
        <span class="tm">${esc((f.timestamp || '').slice(11, 19))}</span>
        <span class="ty">${esc(FEED_LABEL[f.type] || f.type.replace('task_', ''))}</span>
        <span class="ti">${esc((f.taskTitle || f.taskId || '').slice(0, 96))}</span>
        <span class="ac">${esc(shortAddr(f.actor))}</span>
      </li>`).join('');
  }

  function mondayOf(day) {
    const d = new Date(day + 'T00:00:00Z');
    const wd = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - wd);
    return d.toISOString().slice(0, 10);
  }

  function shortAddr(a) {
    if (!a) return '';
    return a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a;
  }

  /* ------------------------------------------------------------ capital */

  function renderCapital() {
    const t = chain().tasks, c = CHAIN[state.chain];
    const posters = t.topPosters || [];
    const mx = Math.max(1, ...posters.map((p) => p.reward));
    const byReward = posters.slice().sort((a, b) => b.reward - a.reward);
    const mostActive = posters[0];
    const biggest = byReward[0];
    $('#capitalLede').innerHTML = `${num(t.distinctPosters)} distinct wallets posted the ${num(t.count)} listed ${c.name} tasks. ` +
      `The ten largest put up ${pctTxt(t.top10RewardShare)} of the ${usd(t.totalReward)} offered. ` +
      (biggest ? `One wallet put up ${pctTxt(biggest.shareReward)} across ${num(biggest.tasks)} tasks, while the most active poster's ${num(mostActive.tasks)} tasks carried ${pctTxt(mostActive.shareReward)}.` : '');
    $('#capitalTitle').innerHTML = c.name === 'Tempo' ? 'Tempo runs on a few <em>wallets</em>.' : 'Base spreads wider, and <em>quieter</em>.';

    $('#posters').innerHTML = byReward.slice(0, 10).map((p) => `
      <div class="poster">
        <span class="a">${esc(p.short)}<span class="sub">${num(p.tasks)} tasks</span></span>
        <span class="b"><i style="width:${(100 * p.reward / mx).toFixed(1)}%"></i></span>
        <span class="s">${pctTxt(p.shareReward)}</span>
      </div>`).join('');

    $('#capitalPairs').innerHTML = [
      ['Distinct posters', num(t.distinctPosters)],
      ['Top wallet · tasks', pctTxt(t.top1TasksShare)],
      ['Top 5 · reward', pctTxt(t.top5RewardShare)],
      ['Top 10 · reward', pctTxt(t.top10RewardShare)],
      ['Held in open tasks', `${usd(t.openReward)} in ${num(t.openTasks)} tasks`],
      ['Median reward', usd(t.medianReward)],
      ['90th percentile reward', usd(t.p90Reward)],
      ['Tasks under $5', `${num(t.under5)} of ${num(t.count)}`],
      ['Dead or expired', `${num(t.dead)} (${pctTxt(t.deadShare)} of settled)`],
    ].map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');

    const A = state.data.chains['4217'].tasks, B = state.data.chains['8453'].tasks;
    const row = (label, a, b) => `<tr><td class="name">${label}</td><td>${a}</td><td>${b}</td></tr>`;
    $('#compareTable').innerHTML = `
      <thead><tr><th>Metric</th><th>Tempo</th><th>Base</th></tr></thead>
      <tbody>
      ${row('Tasks posted', num(A.recent30.tasks), num(B.recent30.tasks))}
      ${row('Reward put up', usd(A.recent30.reward), usd(B.recent30.reward))}
      ${row('Distinct posters', num(A.recent30.posters), num(B.recent30.posters))}
      ${row('Submissions', num(A.recent30.subs), num(B.recent30.subs))}
      ${row('Submissions / task', A.subsPerTask, B.subsPerTask)}
      ${row('Median reward', usd(A.medianReward), usd(B.medianReward))}
      ${row('Top 10 · reward share', pctTxt(A.top10RewardShare), pctTxt(B.top10RewardShare))}
      ${row('Dead share (settled)', pctTxt(A.deadShare), pctTxt(B.deadShare))}
      ${row('Settled with no submission', pctTxt(A.zeroSubSettledShare), pctTxt(B.zeroSubSettledShare))}
      <tr><td class="name">Paid workers · all time</td><td>${num(state.data.chains['4217'].market.paidWorkers)}</td><td>${num(state.data.chains['8453'].market.paidWorkers)}</td></tr>
      <tr><td class="name">Active wallets</td><td>${num(state.data.chains['4217'].market.activeWallets)}</td><td>${num(state.data.chains['8453'].market.activeWallets)}</td></tr>
      </tbody>`;
  }

  /* ------------------------------------------------------------ time */

  function seriesRows() {
    return platformSeries()[state.range] || [];
  }

  function renderCharts() {
    const rows = seriesRows();
    $$('#charts [data-chart]').forEach((box) => drawChart(box, rows, box.dataset.chart));
    $$('#rangeChips button').forEach((b) => b.classList.toggle('on', b.dataset.range === state.range));
  }

  function drawChart(box, rows, key) {
    const W = Math.max(220, box.clientWidth || 300), H = 128;
    const isMoney = key === 'rewardVolume' || key === 'paidVolume';
    const vals = rows.map((r) => isMoney ? Number(r[key]) / 1e6 : Number(r[key] || 0));
    const max = Math.max(1, ...vals);
    const padB = 16, padT = 12;
    const n = vals.length;
    const bw = (W - 2) / Math.max(1, n);
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${key}">`;
    // gridlines
    [0.5, 1].forEach((f) => {
      const y = padT + (1 - f) * (H - padB - padT);
      svg += `<line class="grid" x1="0" x2="${W}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
    });
    const fmtV = (v) => isMoney ? usd(v, 0) : num(Math.round(v));
    if (n <= 65) {
      vals.forEach((v, i) => {
        const h = Math.max(v > 0 ? 1.5 : 0, (v / max) * (H - padB - padT));
        const x = i * bw + 0.5, w = Math.max(1, bw - 1.2);
        svg += `<rect x="${x.toFixed(1)}" y="${(H - padB - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="${isMoney ? '#D9A097' : '#EFE9E2'}" opacity="${(0.55 + 0.45 * (v / max)).toFixed(2)}"><title>${esc(rows[i].bucket)} · ${esc(fmtV(v))}</title></rect>`;
      });
    } else {
      const pts = vals.map((v, i) => [i * (W / (n - 1)), padT + (1 - v / max) * (H - padB - padT)]);
      const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
      const area = d + `L${W} ${H - padB}L0 ${H - padB}Z`;
      svg += `<path d="${area}" fill="#D9A097" opacity=".12"/>`;
      svg += `<path d="${d}" fill="none" stroke="#EFE9E2" stroke-width="1.2"/>`;
      const last = pts[pts.length - 1];
      svg += `<circle cx="${last[0]}" cy="${last[1]}" r="2" fill="#E74079"/>`;
    }
    svg += `<line class="zero" x1="0" x2="${W}" y1="${H - padB}" y2="${H - padB}"/>`;
    svg += `<text class="axis" x="0" y="${padT - 2}">${esc(fmtV(max))}</text>`;
    if (n) {
      svg += `<text class="axis" x="0" y="${H - 3}">${esc(shortDate(rows[0].bucket))}</text>`;
      svg += `<text class="axis" x="${W}" y="${H - 3}" text-anchor="end">${esc(shortDate(rows[n - 1].bucket))}</text>`;
    }
    svg += '</svg>';
    box.innerHTML = svg;
  }

  /* ------------------------------------------------------------ rhythm */

  function renderRhythm() {
    const hm = state.data.platform.heatmap;
    const hour = hm[state.range] && hm[state.range].hourOfWeek;
    const mode = (hm['30d'] && hm['30d'].mode) || hm[state.range].mode;
    const cellMap = {};
    let busiest = null;
    (hour ? hour.cells : []).forEach((c) => {
      cellMap[c[0] + ':' + c[1]] = c[2];
      if (!busiest || c[2] > busiest.count) busiest = { row: c[0], col: c[1], count: c[2] };
    });
    const max = (hour && hour.maxCount) || 1;

    let html = '<div class="hl"></div>';
    for (let h = 0; h < 24; h++) html += `<div class="ht">${h % 6 === 0 ? h : ''}</div>`;
    for (let d = 0; d < 7; d++) {
      html += `<div class="hl">${weekday(d)}</div>`;
      for (let h = 0; h < 24; h++) {
        const v = cellMap[d + ':' + h] || 0;
        const a = v ? 0.08 + 0.9 * Math.pow(v / max, 0.7) : 0;
        html += `<div class="cell"><div class="hc" style="background:${v ? `rgba(239,233,226,${a.toFixed(2)})` : 'rgba(69,62,55,.35)'}" data-tip="${weekday(d)} ${String(h).padStart(2, '0')}:00 UTC · ${num(v)} events"></div></div>`;
      }
    }
    $('#heatHour').innerHTML = html;
    $('#heatHour').style.gridTemplateColumns = '34px repeat(24,1fr)';
    if (busiest) {
      const d = +busiest.row, h = +busiest.col;
      $('#rhythmLede').innerHTML = `The busiest window in the selected range is ${weekday(d)} ${String(h).padStart(2, '0')}:00 UTC with ${num(busiest.count)} events. Rows are UTC weekdays; the API returns the grid platform-wide.`;
    }

    if (mode) {
      const cols = mode.colKeys.slice(-14);
      const cells = {};
      mode.cells.forEach((c) => { cells[c[0] + ':' + c[1]] = c[2]; });
      let m = '<div class="hl"></div>';
      cols.forEach((c, i) => { m += `<div class="ht">${i % 3 === 0 ? shortDate(c).split(' ')[0] : ''}</div>`; });
      mode.rowKeys.forEach((r) => {
        m += `<div class="hl" style="text-transform:none">${esc(r)}</div>`;
        cols.forEach((c) => {
          const v = cells[r + ':' + c] || 0;
          const a = v ? 0.08 + 0.9 * Math.pow(v / (mode.maxCount || 1), 0.7) : 0;
          m += `<div class="cell"><div class="hc" style="background:${v ? `rgba(217,160,151,${a.toFixed(2)})` : 'rgba(69,62,55,.35)'}" data-tip="${esc(r)} · ${esc(c)} · ${num(v)} tasks"></div></div>`;
        });
      });
      $('#heatMode').innerHTML = m;
      $('#heatMode').style.gridTemplateColumns = `${window.innerWidth < 620 ? 52 : 78}px repeat(${cols.length},1fr)`;
    }
    renderModeStatus();
  }

  function renderModeStatus() {
    const rows = chain().tasks.board || [];
    const modes = ['bounty', 'claim', 'pitch', 'benchmark', 'auction'];
    const statuses = ['completed', 'open', 'claimed', 'pending_approval', 'expired', 'cancelled', 'worker_selected'];
    const present = statuses.filter((s) => rows.some((r) => r[1] === s));
    const m = {};
    rows.forEach((r) => { const k = r[2] + '|' + r[1]; m[k] = (m[k] || 0) + 1; });
    $('#modeStatus').innerHTML = `<thead><tr><th>Mode</th>${present.map((s) => `<th>${esc(STATUS_LABEL[s] || s)}</th>`).join('')}<th>all</th></tr></thead>
      <tbody>${modes.filter((mo) => rows.some((r) => r[2] === mo)).map((mo) => {
        const tot = rows.filter((r) => r[2] === mo).length;
        return `<tr><td class="name">${esc(mo)}</td>${present.map((s) => `<td>${num(m[mo + '|' + s] || 0)}</td>`).join('')}<td>${num(tot)}</td></tr>`;
      }).join('')}</tbody>`;
  }

  /* ------------------------------------------------------------ posters */

  function renderPosters() {
    const A = state.data.chains['4217'].tasks.weeks || [];
    const B = state.data.chains['8453'].tasks.weeks || [];
    const weeks = [...new Set([...A.map((w) => w.week), ...B.map((w) => w.week)])].sort().slice(-12);
    const map = (arr) => Object.fromEntries(arr.map((w) => [w.week, w]));
    const am = map(A), bm = map(B);
    const rows = weeks.map((w) => {
      const a = am[w] || { posters: 0, tasks: 0 }, b = bm[w] || { posters: 0, tasks: 0 };
      return { w, a, b, total: a.posters + b.posters };
    });
    $('#weeksTable').innerHTML = `
      <thead><tr><th>Week (Mon–Sun, UTC)</th><th>Tempo posters</th><th>Tempo tasks</th><th>Base posters</th><th>Base tasks</th><th>Both</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="name">${esc(shortDate(r.w))}${r.w === state.data.chains['4217'].tasks.currentWeek ? ' <span class="pill">current</span>' : ''}</td>
        <td>${num(r.a.posters)}</td><td>${num(r.a.tasks)}</td>
        <td>${num(r.b.posters)}</td><td>${num(r.b.tasks)}</td><td>${num(r.total)}</td></tr>`).join('')}</tbody>`;
  }

  /* ------------------------------------------------------------ methods */

  function renderMethods() {
    const d = state.data;
    const iso = d.dataAsOf || d.generatedAt;
    $('#asOfTop').textContent = 'DATA AS OF ' + iso.slice(11, 16) + ' UTC';
    $('#asOfTop').title = iso;
    $('#asOfMethods').textContent = iso;
    $('#tasksAsOf').textContent = d.tasksFetchedAt || iso;
    const A = d.chains['4217'].tasks, B = d.chains['8453'].tasks;
    $('#coverage').textContent = `Tempo ${num(A.count)} tasks since ${A.from.slice(0, 10)}; Base ${num(B.count)} since ${B.from.slice(0, 10)}. The platform breakdown counts ${num(totalBreakdown())} tasks in all, so this list is the recent part of the market.`;
    $('#heroNote').textContent = `${CHAIN[state.chain].name} · ${num(chain().tasks.count)} listed tasks · ${usd(chain().tasks.totalReward)} put up`;
    $('#endpoints').innerHTML = `
      <thead><tr><th>Endpoint</th><th style="text-align:left">Used for</th></tr></thead>
      <tbody>${(d.endpoints || []).map((e) => `<tr><td class="name mono">${esc(e.path)}</td><td class="name" style="text-align:left;white-space:normal;color:#B0A79D">${esc(e.used)}</td></tr>`).join('')}</tbody>`;
  }

  function totalBreakdown() {
    const b = state.data.platform.breakdowns;
    return (b.status || []).reduce((n, s) => n + s.count, 0);
  }

  /* ------------------------------------------------------------ canvas */

  const canvasState = { hubs: [], base: null, raf: 0 };

  function drawSwarm() {
    const cv = $('#swarmCanvas');
    const rect = cv.getBoundingClientRect();
    const W = Math.max(280, Math.round(rect.width)), H = Math.max(200, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const items = (chain().tasks.topTasks || []).slice(0, W < 460 ? 6 : 8);
    if (!items.length) return;
    const capN = document.getElementById('capCount');
    if (capN) capN.textContent = String(items.length);
    const cols = W < 460 ? 2 : 4;
    const rows = Math.ceil(items.length / cols);
    const cellW = W / cols, cellH = H / rows;
    const hubs = items.map((x, i) => ({
      x: (i % cols) * cellW + cellW / 2,
      top: Math.floor(i / cols) * cellH,
      y: Math.floor(i / cols) * cellH + cellH / 2 + 3,
      maxR: Math.min(cellW * 0.31, cellH / 2 - 26),
      data: x,
    }));
    canvasState.hubs = hubs;

    const base = document.createElement('canvas');
    base.width = W * dpr; base.height = H * dpr;
    const b = base.getContext('2d');
    b.setTransform(dpr, 0, 0, dpr, 0, 0);
    b.clearRect(0, 0, W, H);

    // faint field
    b.strokeStyle = 'rgba(69,62,55,.35)';
    b.lineWidth = 1;
    for (let x = 14; x < W; x += 28) b.beginPath(), b.moveTo(x, 0), b.lineTo(x, H), b.stroke();

    hubs.forEach((hub) => {
      const n = Math.min(hub.data.subs || 0, 900);
      const t = hub.data;
      // warm glow under the swarm
      const g = b.createRadialGradient(hub.x, hub.y, 2, hub.x, hub.y, hub.maxR * 1.25);
      g.addColorStop(0, 'rgba(231,64,121,.16)');
      g.addColorStop(.45, 'rgba(58,20,32,.55)');
      g.addColorStop(1, 'rgba(58,20,32,0)');
      b.fillStyle = g;
      b.beginPath(); b.arc(hub.x, hub.y, hub.maxR * 1.25, 0, Math.PI * 2); b.fill();
      // convergence threads
      for (let k = 0; k < 46; k++) {
        const a = (k / 46) * Math.PI * 2 + (hub.data.subs % 7) * 0.11;
        const r0 = hub.maxR * 1.18, r1 = hub.maxR * 0.18;
        const lg = b.createLinearGradient(hub.x + Math.cos(a) * r0, hub.y + Math.sin(a) * r0,
          hub.x + Math.cos(a) * r1, hub.y + Math.sin(a) * r1);
        lg.addColorStop(0, 'rgba(239,233,226,0)');
        lg.addColorStop(1, 'rgba(239,233,226,.16)');
        b.strokeStyle = lg; b.lineWidth = 0.8;
        b.beginPath();
        b.moveTo(hub.x + Math.cos(a) * r0, hub.y + Math.sin(a) * r0);
        b.lineTo(hub.x + Math.cos(a) * r1, hub.y + Math.sin(a) * r1);
        b.stroke();
      }
      // one dot per submission, spread evenly across the field
      const dotR = n > 400 ? 1 : n > 150 ? 1.15 : 1.35;
      for (let k = 0; k < n; k++) {
        const r = hub.maxR * Math.sqrt((k + 0.6) / n);
        const a = k * 2.399963 + 0.6;
        const x = hub.x + Math.cos(a) * r, y = hub.y + Math.sin(a) * r;
        b.beginPath();
        b.fillStyle = k % 9 === 0 ? 'rgba(217,160,151,.55)' : 'rgba(239,233,226,.5)';
        b.arc(x, y, dotR, 0, Math.PI * 2);
        b.fill();
      }
      // hub tile
      const s = 9;
      b.fillStyle = '#FFF6E8';
      b.beginPath();
      if (b.roundRect) b.roundRect(hub.x - s / 2, hub.y - s / 2, s, s, 2); else b.rect(hub.x - s / 2, hub.y - s / 2, s, s);
      b.fill();
      b.fillStyle = '#E74079';
      b.fillRect(hub.x - 2, hub.y - 2, 4, 4);
      // labels in reserved bands, above and below the ring field
      const fs = W < 460 ? 8 : 9.5;
      b.font = `${fs}px "Departure Mono", monospace`;
      b.textAlign = 'center';
      b.fillStyle = 'rgba(239,233,226,.8)';
      b.fillText(`${t.ref || ''} · ${usd(t.reward)} · ${num(t.subs)}`, hub.x, hub.y + hub.maxR + 15);
    });

    canvasState.base = base;

    let frame = 0;
    const loop = () => {
      if (document.hidden) { canvasState.raf = 0; return; }
      frame++;
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(base, 0, 0, W, H);
      const hub = hubs[frame % hubs.length];
      const phase = (frame % 90) / 90;
      ctx.beginPath();
      ctx.strokeStyle = `rgba(231,64,121,${(0.22 * (1 - phase)).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.arc(hub.x, hub.y, 8 + phase * (hub.maxR + 6), 0, Math.PI * 2);
      ctx.stroke();
      // a spark travels from the outer ring to the hub
      if (frame % 6 === 0) {
        const a = Math.random() * Math.PI * 2;
        const r0 = hub.maxR + 8, r1 = 6;
        const x0 = hub.x + Math.cos(a) * r0, y0 = hub.y + Math.sin(a) * r0;
        const x1 = hub.x + Math.cos(a) * r1, y1 = hub.y + Math.sin(a) * r1;
        const g = ctx.createLinearGradient(x0, y0, x1, y1);
        g.addColorStop(0, 'rgba(239,233,226,0)');
        g.addColorStop(1, 'rgba(239,233,226,.55)');
        ctx.beginPath();
        ctx.strokeStyle = g;
        ctx.lineWidth = 1;
        ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
      canvasState.raf = requestAnimationFrame(loop);
    };
    if (!canvasState.raf) canvasState.raf = requestAnimationFrame(loop);
  }

  /* ------------------------------------------------------------ render */

  function renderAll() {
    renderBand();
    renderBoard();
    renderSwarm();
    renderFeed();
    renderCapital();
    renderCharts();
    renderRhythm();
    renderPosters();
    renderMethods();
    drawSwarm();
    $$('.seg button[data-chain]').forEach((b) => b.classList.toggle('on', b.dataset.chain === state.chain));
    $('#capChain').textContent = CHAIN[state.chain].name;
  }

  /* ------------------------------------------------------------ boot */

  function bind() {
    $$('.seg button[data-chain]').forEach((b) => b.addEventListener('click', () => {
      state.chain = b.dataset.chain;
      writeUrl(state.view);
      renderAll();
    }));
    $('#copyLink').addEventListener('click', () => copyLink(state.view));
    $('#modeChips').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-mode]');
      if (!b) return;
      state.mode = b.dataset.mode;
      renderBoard();
    });
    $('#rangeChips').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-range]');
      if (!b) return;
      state.range = b.dataset.range;
      writeUrl(state.view);
      renderCharts();
      renderRhythm();
    });
    $$('.sec[id]').forEach((sec) => {
      const h = sec.querySelector('.sec-head');
      if (!h) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'anchor-copy mono small';
      btn.textContent = 'copy link to this view';
      btn.style.cssText = 'background:none;border:0;border-bottom:1px solid #453E37;color:#B0A79D;padding:0 0 2px;margin-top:14px;cursor:pointer;font-size:11px';
      btn.addEventListener('click', () => copyLink(sec.id));
      h.appendChild(btn);
    });
    let rt;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => { renderCharts(); drawSwarm(); }, 180);
    });
  }

  async function load(first) {
    const pending = (first && window.__floorData)
      ? window.__floorData
      : fetch('/api/data', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null));
    if (first) window.__floorData = null;
    const d = await pending;
    if (!d) throw new Error('data unavailable');
    const changed = !state.data || state.data.generatedAt !== d.generatedAt;
    state.data = d;
    if (changed) renderAll();
    if (first) {
      bind();
      if (state.view) {
        const el = document.getElementById(state.view);
        if (el) setTimeout(() => el.scrollIntoView(), 40);
      }
    }
  }

  readUrl();
  load(true).catch((e) => {
    console.error('floor load', e);
    document.querySelector('.hero-note').textContent = 'Data is warming up. Reload in a moment.';
    setTimeout(() => load(true).catch(() => {}), 4000);
  });
  setInterval(() => load(false).catch(() => {}), 60000);
})();
