(() => {
  const D = window.SKEW_DATA;
  const $ = (id) => document.getElementById(id);
  if (!D) { document.querySelector('main').innerHTML = '<p class="card">No data yet. Run <code>python build_data.py</code> first.</p>'; return; }

  const S = D.settings;
  const state = { sector: 'all', set: 'all', thin: true, h: 'r1m', sort: 'dv', dir: -1, open: null };
  const HN = { r1d: 'day', r1w: 'week', r1m: 'month' };
  const Q = {
    contrarian: { name: 'CONTRARIAN BID', side: 'calls', looks: 'Down on the month, yet calls are bid.', means: 'Price and positioning disagree — the one box where the chain says something the chart does not.', act: 'Watchlist. Investigate, don\'t buy.' },
    chase: { name: 'CHASE', side: 'calls', looks: 'Up on the month, and calls are bid.', means: 'Everyone agrees. Crowded rather than wrong.', act: 'Late. A worse entry than it was — don\'t chase.' },
    hedged: { name: 'HEDGED RALLY', side: 'puts', looks: 'Up on the month, but puts are bid.', means: 'The rally is being insured. That is hedging, not enthusiasm.', act: 'Tighten stops on anything held. Not an exit signal.' },
    fear: { name: 'FEAR', side: 'puts', looks: 'Down on the month, and puts are bid.', means: 'Falling, with protection getting dearer. Agreement in the other direction.', act: 'Leave it alone. Not a bargain yet.' },
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const f1 = (v, d = 1) => v == null ? '–' : v.toFixed(d);
  const sg = (v, d = 1) => v == null ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d);
  const pct = (v, d = 1) => v == null ? '–' : sg(v, d) + '%';
  const weak = (s) => s.trusted ? '' : s.n < S.min_names_per_sector ? `only ${s.n} solid names` : 'mixed';
  const byT = Object.fromEntries([...D.rows, ...D.indices].map((r) => [r.t, r]));

  // ---------- the sentence: same order for every name, everywhere ----------
  function sentence(r) {
    const a = Math.abs(r.skew), side = r.skew >= 0 ? 'puts' : 'calls';
    const strength = a < 0.04 ? 'slightly' : a < 0.12 ? 'clearly' : 'heavily';
    let rank = '';
    if (r.rank != null) rank = r.skew >= 0
      ? `, more fear premium than ${r.rank}% of its ${r.sector} peers`
      : `, more upside lean than ${100 - r.rank}% of its ${r.sector} peers`;
    const vol = r.rvol == null ? 'unknown' : r.rvol >= S.rvol.heavy ? 'heavy' : r.rvol <= S.rvol.light ? 'light' : 'normal';
    const q = Q[r.quad];
    let s = `Traders are paying ${strength} more for ${side}${rank}. The stock is ${r.r1m >= 0 ? 'up' : 'down'} ${Math.abs(r.r1m).toFixed(1)}% on the month`
      + (r.vs_spy != null && r.sector !== 'Index' ? ` (${pct(r.vs_spy)} vs SPY)` : '') + `, on ${vol} volume. That puts it in ${q.name}: ${q.act}`;
    if (r.thin.length) s += ` ⚠ Thin chain (${r.thin.join(', ')}) — treat as noise.`;
    if (r.earn_in) s += ` ⚠ Earnings on ${r.earn} fall inside the ${r.exp} expiry — this is event premium, not sentiment.`;
    return s;
  }
  const tipHtml = (r) => `<b>${r.t}</b> <span class="tag ${r.quad}">${Q[r.quad].name}</span><div class="t2">${sentence(r)}</div>
    <div class="t2">Skew ${sg(r.skew, 3)} · ${sg(r.vp)} vol pts · ATM IV ${f1(r.atm)}%${r.d_skew != null ? ` · Δ ${sg(r.d_skew, 3)}` : ''}</div>`;

  // ---------- tooltip ----------
  const tip = $('tip');
  function bindTip(el, html) {
    el.addEventListener('mousemove', (e) => {
      tip.innerHTML = typeof html === 'function' ? html() : html; tip.hidden = false;
      const w = tip.offsetWidth, h = tip.offsetHeight;
      tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, e.clientX + 14)) + 'px';
      tip.style.top = (e.clientY + h + 24 > innerHeight ? e.clientY - h - 12 : e.clientY + 16) + 'px';
    });
    el.addEventListener('mouseleave', () => { tip.hidden = true; });
  }
  const svgEl = (tag, attrs = {}, text) => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  };
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  function filtered() {
    return D.rows.filter((r) => (state.sector === 'all' || r.sector === state.sector)
      && (state.set === 'all' || (state.set === 'watch' ? r.watch : r.bench))
      && (state.thin || !r.thin.length));
  }
  const solid = (rows) => rows.filter((r) => !r.thin.length);

  // ---------- header, tiles, written read ----------
  function renderMeta() {
    $('meta').innerHTML = `Options as of <b>${D.asof}</b> UTC (about 15 min delayed)<br>${D.rows.length} names · ${D.excluded.length} not covered · ${D.snapshots} snapshot${D.snapshots === 1 ? '' : 's'} banked`;
  }
  function renderTiles() {
    const sec = D.sectors, trusted = sec.filter((s) => s.trusted);
    const hedged = [...(trusted.length ? trusted : sec)].sort((a, b) => b.vp - a.vp)[0];
    const gain = [...sec].sort((a, b) => b.share_chg - a.share_chg)[0], lose = [...sec].sort((a, b) => a.share_chg - b.share_chg)[0];
    const c = { contrarian: 0, chase: 0, hedged: 0, fear: 0 };
    solid(D.rows).forEach((r) => c[r.quad]++);
    const flow = (s) => `${sg(s.share_chg, 2)} pts of dollar volume vs prior month · avg 1M ${pct(s.r1m)}`;
    const tiles = [
      ['Volume share gaining', gain.sector, flow(gain)],
      ['Volume share losing', lose.sector, flow(lose)],
      ['Most hedged sector', hedged.sector, `${sg(hedged.vp)} vol pts · ${Math.round(hedged.agree * 100)}% of names lean ${hedged.lean}`],
      ['Where names sit', `${c.contrarian + c.chase} calls bid · ${c.hedged + c.fear} puts bid`, `${c.contrarian} contrarian · ${c.chase} chase · ${c.hedged} hedged rally · ${c.fear} fear`],
    ];
    $('tiles').innerHTML = tiles.map(([k, v, d]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join('');
  }
  function renderRead() {
    const rows = solid(D.rows), out = [], names = (a) => a.map((r) => r.t).join(', ');
    const spy = byT.SPY;
    const putShare = Math.round(100 * rows.filter((r) => r.skew > 0).length / rows.length);
    out.push([`${putShare}% of covered names have puts priced above calls` + (spy ? `; SPY is ${pct(spy.r1m)} on the month carrying ${sg(spy.vp)} vol points of put premium.` : '.')
      + ' Put skew is the resting state for equities, so the level alone says little.']);
    const sec = [...D.sectors].sort((a, b) => b.vp - a.vp), top = sec[0];
    out.push([`${top.sector} carries the most fear premium (${sg(top.vp)} vol pts), with ${Math.round(top.agree * 100)}% of its names leaning ${top.lean}`
      + (top.trusted ? '.' : ` — but ${weak(top)}, so this is a few names, not a sector move.`)]);
    const div = D.sectors.filter((s) => s.share_chg < -0.15 && s.r1m > 0);
    if (div.length) out.push([`Flow and price disagree in ${div.map((s) => s.sector).join(', ')}: price is up on the month while share of dollar volume is shrinking.`, 1]);
    const con = rows.filter((r) => r.quad === 'contrarian').sort((a, b) => a.skew - b.skew);
    out.push([con.length ? `Contrarian bid — down on the month with calls bid: ${names(con.slice(0, 8))}${con.length > 8 ? ` and ${con.length - 8} more` : ''}. Watchlist material, nothing more.`
      : 'No name sits in the contrarian-bid box today. That box is usually near-empty; an empty one is information too.']);
    const hr = rows.filter((r) => r.r1m > 3 && r.rank >= 80).sort((a, b) => b.r1m - a.r1m);
    if (hr.length) out.push([`Caution flags — up on the month while carrying more put premium than most sector peers: ${names(hr.slice(0, 6))}. Tighten, don't exit.`, 1]);
    if (D.prior_date) {
      const mv = rows.filter((r) => r.d_skew != null).sort((a, b) => Math.abs(b.d_skew) - Math.abs(a.d_skew)).slice(0, 5);
      if (mv.length) out.push([`Biggest skew changes since ${D.prior_date}: ${mv.map((r) => `${r.t} ${sg(r.d_skew, 3)}`).join(', ')}.`]);
    } else out.push([`Change columns are blank: ${D.snapshots} snapshot${D.snapshots === 1 ? '' : 's'} banked, and a comparison needs one at least ${S.change_lookback_days} days old. Keep running it — the change is the signal, the level is structural.`]);
    const ev = D.rows.filter((r) => r.earn_in);
    if (ev.length) out.push([`${ev.length} name${ev.length === 1 ? ' has' : 's have'} earnings inside the measured expiry (tagged EVT); their elevated IV is event premium.`]);
    $('read').innerHTML = out.map(([t, flag]) => `<li${flag ? ' class="flag"' : ''}>${t}</li>`).join('');
  }

  // ---------- quadrant map ----------
  function renderMap() {
    const rows = filtered(), h = state.h;
    const pts = [...rows, ...(state.sector === 'all' && state.set === 'all' ? D.indices : [])];
    const W = 760, H = 440, m = { l: 48, r: 16, t: 18, b: 38 };
    const host = $('map'); host.innerHTML = '';
    if (!pts.length) { host.innerHTML = '<p class="empty">No names match these filters.</p>'; return; }
    const ext = (vals, pad) => { let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals); const p = (hi - lo) * pad || 1; return [lo - p, hi + p]; };
    const [x0, x1] = ext(pts.map((r) => r[h]), 0.06), [y0, y1] = ext(pts.map((r) => r.skew), 0.08);
    const X = (v) => m.l + (v - x0) / (x1 - x0) * (W - m.l - m.r), Y = (v) => H - m.b - (v - y0) / (y1 - y0) * (H - m.t - m.b);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Skew versus return scatter plot' });
    const ticks = (lo, hi, n) => { const st = Math.pow(10, Math.floor(Math.log10((hi - lo) / n))); const s = [1, 2, 5, 10].map((k) => k * st).find((k) => (hi - lo) / k <= n + 1); const a = []; for (let v = Math.ceil(lo / s) * s; v <= hi; v += s) a.push(+v.toFixed(6)); return a; };
    ticks(x0, x1, 8).forEach((v) => { svg.append(svgEl('line', { class: v ? 'gridl' : 'zero', x1: X(v), x2: X(v), y1: m.t, y2: H - m.b }), svgEl('text', { x: X(v), y: H - m.b + 15, 'text-anchor': 'middle' }, pct(v, 0))); });
    ticks(y0, y1, 6).forEach((v) => { svg.append(svgEl('line', { class: v ? 'gridl' : 'zero', x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }), svgEl('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end' }, sg(v, 2))); });
    svg.append(svgEl('text', { x: (W + m.l) / 2, y: H - 4, 'text-anchor': 'middle', class: 'lbl' }, `Return over the last ${HN[h]}  →`),
      svgEl('text', { x: 12, y: (H - m.b + m.t) / 2, 'text-anchor': 'middle', class: 'lbl', transform: `rotate(-90 12 ${(H - m.b + m.t) / 2})` }, 'Skew  (puts pricier ↑)'));
    [['HEDGED RALLY', W - m.r - 6, m.t + 12, 'end'], ['FEAR', m.l + 6, m.t + 12, 'start'], ['CONTRARIAN BID', m.l + 6, H - m.b - 8, 'start'], ['CHASE', W - m.r - 6, H - m.b - 8, 'end']]
      .forEach(([t, x, y, a]) => svg.append(svgEl('text', { class: 'qlabel', x, y, 'text-anchor': a }, t)));
    const sk = solid(rows).map((r) => r.skew).sort((a, b) => a - b);
    if (sk.length > 4) {
      const med = sk[Math.floor(sk.length / 2)];
      svg.append(svgEl('line', { class: 'idxl', x1: m.l, x2: W - m.r, y1: Y(med), y2: Y(med) }), svgEl('text', { x: W - m.r - 4, y: Y(med) - 4, 'text-anchor': 'end' }, `median ${sg(med, 2)}`));
    }
    const css = getComputedStyle(document.documentElement), col = (n) => css.getPropertyValue(n).trim();
    const order = [...pts].sort((a, b) => (a.watch ? 1 : 0) - (b.watch ? 1 : 0));
    order.forEach((r) => {
      const c = r.sector === 'Index' ? col('--ink') : r.watch ? col('--watch') : col('--neutral');
      let mk;
      if (r.sector === 'Index') mk = svgEl('rect', { class: 'mark', x: X(r[h]) - 5, y: Y(r.skew) - 5, width: 10, height: 10, fill: c, transform: `rotate(45 ${X(r[h])} ${Y(r.skew)})` });
      else mk = svgEl('circle', { cx: X(r[h]), cy: Y(r.skew), r: r.watch ? 6 : 5, fill: c, class: r.thin.length ? 'thin' : '', ...(r.thin.length ? { style: `stroke:${c}` } : {}), 'fill-opacity': r.watch ? 1 : 0.75 });
      bindTip(mk, () => tipHtml(r));
      svg.append(mk);
    });
    // selective direct labels: watchlist, indices, and the extremes; greedy collision skip
    const cand = [...pts].sort((a, b) => score(b) - score(a));
    function score(r) { return (r.sector === 'Index' ? 5 : 0) + (r.watch ? 3 : 0) + Math.abs(r[h] - (x0 + x1) / 2) / (x1 - x0) * 4 + Math.abs(r.skew - (y0 + y1) / 2) / (y1 - y0) * 4 + (r.skew < 0 ? 2 : 0); }
    const boxes = [];
    cand.slice(0, 40).forEach((r) => {
      const w = r.t.length * 7 + 4, x = X(r[h]) + 8, y = Y(r.skew) + 4;
      const flip = x + w > W - m.r, bx = flip ? X(r[h]) - 8 - w : x, b = [bx, y - 11, bx + w, y + 3];
      if (boxes.length >= 22 || boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1])) return;
      boxes.push(b);
      svg.append(svgEl('text', { class: 'name', x: flip ? X(r[h]) - 8 : x, y, 'text-anchor': flip ? 'end' : 'start' }, r.t));
    });
    host.append(svg);
    $('map-note').textContent = `Expect it lopsided: most equities rest with puts above calls, so the two lower boxes are sparse — which is why they are the interesting ones. The dashed line is the median of the names shown. Verdicts stay on the 1-month clock`
      + (h === 'r1m' ? '.' : `; you are viewing the 1-${HN[h]} lens, so a dot's corner here may differ from its verdict.`);
  }

  function renderQuads() {
    const c = {}; solid(D.rows).forEach((r) => { c[r.quad] = (c[r.quad] || 0) + 1; });
    $('quads').innerHTML = ['fear', 'hedged', 'contrarian', 'chase'].map((k) => {
      const q = Q[k];
      return `<div class="quad ${q.side}"><span class="n">${c[k] || 0} names</span><b>${q.name}</b><p>${q.looks} ${q.means}</p><p class="act">→ ${q.act}</p></div>`;
    }).join('');
  }

  // ---------- sector bars (raw vol points) ----------
  function renderSectors() {
    const sec = [...D.sectors].sort((a, b) => b.vp - a.vp), host = $('sectors'); host.innerHTML = '';
    const W = 760, rowH = 28, m = { l: 150, r: 190, t: 26, b: 8 }, H = m.t + sec.length * rowH + m.b;
    const vals = [...sec.map((s) => s.vp), ...D.indices.map((i) => i.vp), 0];
    const lo = Math.min(...vals), hi = Math.max(...vals) * 1.05, X = (v) => m.l + (v - lo) / (hi - lo) * (W - m.l - m.r);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Put minus call implied volatility by sector' });
    svg.append(svgEl('line', { class: 'zero', x1: X(0), x2: X(0), y1: m.t - 4, y2: H - m.b }));
    sec.forEach((s, i) => {
      const y = m.t + i * rowH, x = Math.min(X(0), X(s.vp)), w = Math.max(2, Math.abs(X(s.vp) - X(0)));
      const bar = svgEl('rect', { class: 'mark', x, y: y + 4, width: w, height: rowH - 10, rx: 4, fill: `var(--${s.vp >= 0 ? 'puts' : 'calls'})`, 'fill-opacity': s.trusted ? 1 : 0.4 });
      bindTip(bar, `<b>${s.sector}</b><div class="t2">${sg(s.vp, 2)} vol pts average over ${s.n} names · normalized skew ${sg(s.skew, 3)}<br>${Math.round(s.agree * 100)}% of names lean ${s.lean}`
        + `${s.trusted ? '' : ` — ${weak(s)}: do not call this a sector move`}<br>Avg 1M ${pct(s.r1m)} · ${Math.round(s.up_share * 100)}% of names up · volume share ${f1(s.share)}% (${sg(s.share_chg, 2)})</div>`);
      svg.append(svgEl('text', { class: 'name', x: m.l - 8, y: y + rowH / 2 + 4, 'text-anchor': 'end' }, s.sector), bar,
        svgEl('text', { class: 'lbl', x: X(Math.max(s.vp, 0)) + 6, y: y + rowH / 2 + 4 }, `${sg(s.vp)}  ·  ${Math.round(s.agree * 100)}% agree${s.trusted ? '' : ' — ' + weak(s)}`));
    });
    [...D.indices].sort((a, b) => a.vp - b.vp).forEach((ix, i) => {
      svg.append(svgEl('line', { class: 'idxl', x1: X(ix.vp), x2: X(ix.vp), y1: m.t - 4, y2: H - m.b }),
        svgEl('text', { class: 'lbl', x: X(ix.vp), y: 10 + (i % 2) * 0, 'text-anchor': 'middle' }, ix.t));
    });
    host.append(svg);
  }

  // ---------- sector grid ----------
  function tileColor(skew) {
    const p = Math.min(1, Math.abs(skew) / 0.18);
    return { bg: `color-mix(in oklab, var(--${skew >= 0 ? 'puts' : 'calls'}) ${Math.round(p * 100)}%, var(--mid))`, fg: p > 0.5 ? '#fff' : 'var(--ink)' };
  }
  function renderGrid() {
    const host = $('grid'); host.innerHTML = '';
    D.sectors.filter((s) => state.sector === 'all' || s.sector === state.sector).forEach((s) => {
      const row = el('div', 'srow');
      row.append(el('div', 'sname', `${s.sector}<div class="sinfo">${Math.round(s.agree * 100)}% lean ${s.lean}${s.trusted ? '' : ' · ' + weak(s)}</div>`));
      const tr = el('div', 'tilesrow');
      D.rows.filter((r) => r.sector === s.sector && r.bench).sort((a, b) => b.dv - a.dv).forEach((r) => {
        const c = tileColor(r.skew), t = el('div', 'gt' + (r.thin.length ? ' thin' : ''), `${r.t}<small>${sg(r.skew, 2)}</small>`);
        t.style.cssText = `background:${c.bg};color:${c.fg};flex-grow:${Math.max(1, Math.sqrt(r.dv / 400)).toFixed(2)}`;
        bindTip(t, () => tipHtml(r)); tr.append(t);
      });
      row.append(tr); host.append(row);
    });
  }

  // ---------- shortlist ----------
  function renderShort() {
    const rows = solid(filtered()).filter((r) => r.rank != null);
    const put = (id, list, label, why) => {
      const host = $(id); host.innerHTML = '';
      if (!list.length) { host.innerHTML = '<p class="empty">Nothing qualifies today — which is a reading too.</p>'; return; }
      list.slice(0, 8).forEach((r) => {
        const p = el('div', 'pick', `<b>${r.t}</b><span class="tag ${r.quad}">${label(r)}</span><span>${why(r)}${r.earn_in ? ' <span class="tag ev">EVT</span>' : ''}</span>`);
        bindTip(p, () => tipHtml(r)); host.append(p);
      });
    };
    put('short-bull', rows.filter((r) => r.rank <= 20).sort((a, b) => a.rank - b.rank || a.skew - b.skew),
      (r) => r.r1m < 0 ? 'FRESH LOOK' : 'MOMENTUM',
      (r) => `More upside lean than ${100 - r.rank}% of ${r.sector}; ${pct(r.r1m)} on the month — ${r.r1m < 0 ? 'already fell, worth a chart' : 'already ran, crowded'}.`);
    put('short-hedge', rows.filter((r) => r.r1m > 3 && r.rank >= 80).sort((a, b) => b.r1m - a.r1m),
      () => 'TIGHTEN',
      (r) => `${pct(r.r1m)} on the month with more put premium than ${r.rank}% of ${r.sector}.`);
  }

  // ---------- full board ----------
  const COLS = [
    ['t', 'Ticker', (r) => `<b>${r.t}</b>${r.watch ? ' <span class="w" title="Watchlist">●</span>' : ''}`, 'l'],
    ['sector', 'Sector', (r) => r.sector, 'l'],
    ['quad', 'Verdict', (r) => `<span class="tag ${r.quad}">${Q[r.quad].name}</span>`, 'l'],
    ['skew', 'Skew', (r) => sg(r.skew, 3) + `<span class="bar" style="width:${Math.min(40, Math.abs(r.skew) * 220)}px;background:var(--${r.skew >= 0 ? 'puts' : 'calls'})"></span>`],
    ['d_skew', 'Δ skew', (r) => r.d_skew == null ? '<span class="mutedc">–</span>' : sg(r.d_skew, 3)],
    ['vp', 'Vol pts', (r) => sg(r.vp)],
    ['atm', 'ATM IV', (r) => f1(r.atm)], ['piv', 'Put IV', (r) => f1(r.piv)], ['civ', 'Call IV', (r) => f1(r.civ)],
    ['rank', 'Sector rank', (r) => r.rank == null ? '–' : r.rank + '%'],
    ['r1m', '1M', (r) => pct(r.r1m)], ['vs_spy', 'vs SPY', (r) => pct(r.vs_spy)],
    ['rvol', 'RVOL', (r) => f1(r.rvol, 2)], ['pc', 'P/C OI', (r) => f1(r.pc, 2)], ['dv', '$M/day', (r) => Math.round(r.dv).toLocaleString()],
    ['earn', 'Earnings', (r) => r.earn ? r.earn.slice(5) + (r.earn_in ? ' <span class="tag ev">EVT</span>' : '') : '–', 'l'],
    ['thin', 'Chain', (r) => r.thin.length ? `<span title="${r.thin.join(', ')}">thin ⚠</span>` : 'ok', 'l'],
  ];
  function renderTable() {
    const rows = filtered(), k = state.sort;
    rows.sort((a, b) => {
      const va = k === 'thin' ? a.thin.length : a[k], vb = k === 'thin' ? b.thin.length : b[k];
      if (va == null) return 1; if (vb == null) return -1;
      return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * state.dir;
    });
    const tb = $('board'); tb.innerHTML = '';
    const hr = el('tr');
    COLS.forEach(([key, label, , cls]) => {
      const th = el('th', cls || '', label + (key === k ? (state.dir > 0 ? ' ▲' : ' ▼') : ''));
      th.onclick = () => { state.dir = state.sort === key ? -state.dir : (key === 't' || key === 'sector' ? 1 : -1); state.sort = key; renderTable(); };
      hr.append(th);
    });
    const thead = el('thead'); thead.append(hr); const body = el('tbody');
    rows.forEach((r) => {
      const tr = el('tr', '', COLS.map(([, , fn, cls]) => `<td class="${cls || ''}">${fn(r)}</td>`).join(''));
      tr.onclick = () => { state.open = state.open === r.t ? null : r.t; renderTable(); };
      body.append(tr);
      if (state.open === r.t) body.append(el('tr', 'sent', `<td colspan="${COLS.length}"><b>${r.t}</b> — ${sentence(r)} <span class="mutedc">(expiry ${r.exp}, ${r.dte} days)</span></td>`));
    });
    tb.append(thead, body);
    $('f-count').textContent = `${rows.length} of ${D.rows.length} names`;
  }

  function renderStatic() {
    $('excluded').innerHTML = D.excluded.length ? D.excluded.map((e) => `<li><b>${esc(e.t)}</b> (${esc(e.sector)}) — ${esc(e.why)}</li>`).join('') : '<li>Every name in the universe passed today.</li>';
    const thin = D.rows.filter((r) => r.thin.length);
    if (thin.length) $('excluded').innerHTML += `<li>Shown but flagged thin: ${thin.map((r) => r.t).join(', ')}</li>`;
    const rowsS = [
      ['1 · Strikes', `${Math.round(S.delta * 100)}-delta put vs ${Math.round(S.delta * 100)}-delta call`],
      ['2 · Expiry', `${S.expiry.rule}, ${S.expiry.min_dte}–${S.expiry.max_dte} days out`],
      ['3 · Normalize', 'ATM-normalized within sectors; raw vol points across sectors'],
      ['4 · Universe', `${D.rows.filter((r) => r.bench).length} benchmark names (sector ETF top holdings) kept separate from ${S.watchlist.length} watchlist names`],
      ['5 · Quality bar', `≥${S.quality.min_strikes_per_side} quoted strikes per side, OI ≥ ${S.quality.min_expiry_open_interest}, spread ≤ ${S.quality.max_leg_spread_pct}% — failures shown hollow, excluded from ranks`],
      ['6 · Sanity ceiling', `|skew| > ${S.sanity_ceiling_abs_skew} rejected as a bad quote`],
      ['7 · History', `Daily snapshot stored; change vs ≥${S.change_lookback_days} days earlier`],
      ['Sector agreement', `≥${Math.round(S.agreement_threshold * 100)}% of ≥${S.min_names_per_sector} names, or no sector call`],
      ['Volume', `heavy ≥ ${S.rvol.heavy}× · light ≤ ${S.rvol.light}×`],
    ];
    $('settings').innerHTML = rowsS.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('');
  }

  function refresh() { renderMap(); renderGrid(); renderShort(); renderTable(); }
  $('f-sector').innerHTML = '<option value="all">All sectors</option>' + [...new Set(D.rows.map((r) => r.sector))].sort().map((s) => `<option>${s}</option>`).join('');
  $('f-sector').onchange = (e) => { state.sector = e.target.value; refresh(); };
  $('f-set').onchange = (e) => { state.set = e.target.value; refresh(); };
  $('f-thin').onchange = (e) => { state.thin = e.target.checked; refresh(); };
  $('horizon').onclick = (e) => {
    if (!e.target.dataset.h) return;
    state.h = e.target.dataset.h;
    [...$('horizon').children].forEach((b) => b.classList.toggle('on', b === e.target));
    renderMap();
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderMap);

  renderMeta(); renderTiles(); renderRead(); renderQuads(); renderSectors(); renderStatic(); refresh();
})();
