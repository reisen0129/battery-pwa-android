/* app.js —— 电车电耗记录 PWA 主逻辑
 * 模块职责：
 *   - 视图切换（记录/记一笔/车辆/统计/备份）
 *   - 记录增删、车辆增删改、实时电耗计算与公式校验
 *   - 列表分页 + 下拉刷新 + 上拉加载、删除二次确认
 *   - 统计趋势图（SVG）、CSV 导入导出、报告长图（Canvas）
 *   - 深色模式、WebDAV 同步引导
 * 数据模型：
 *   vehicle = {id, name, capacity(满电kWh), initPct(默认初始%)}
 *   record  = {id, vehicleId, date, ts(数值时间戳), initPct, remainPct, mileage, note, createdAt}
 * 依赖：js/db.js 暴露的全局 BatteryDB（IndexedDB 数据层）
 */
(function () {
  'use strict';

  // ---------- 状态 ----------
  let vehicles = [];
  let records = [];
  let vehicleAvg = {};          // 各车辆累计平均电耗
  let recPage = 1;              // 记录列表分页
  const REC_PAGE = 5;
  let currentView = 'records';
  let currentChartMode = 'month';

  // ---------- 工具 ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function fmt(n, d = 1) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toFixed(d).replace(/\.0$/, '');
  }
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2200);
  }
  // 生成唯一 ID：优先使用浏览器原生 crypto.randomUUID，降级用时间戳+随机串
  function uid() {
    return (crypto.randomUUID && crypto.randomUUID()) || 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }
  // 取当前本地时间并格式化为 <input type="datetime-local"> 所需的 "YYYY-MM-DDTHH:mm"
  function nowLocalInput() {
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // 可靠解析本地日期时间字符串（datetime-local 无时区，视为本地时间）
  function parseLocalDateTime(str) {
    if (str == null) return new Date(NaN);
    const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
    if (m && !m[7]) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    return new Date(str);
  }
  // 时间戳 → 显示用字符串 "YYYY-MM-DD HH:mm"（按本地时区）
  function dateToStr(ts) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ---------- 电耗计算 ----------
  // 消耗电量(kWh) = 满电电量 × (初始% - 剩余%) / 100
  // 电耗(kWh/100km) = 消耗电量 / 里程 × 100
  function compute(initPct, remainPct, capacity, mileage) {
    const dPct = (initPct || 0) - (remainPct || 0);
    const energy = (capacity || 0) * dPct / 100;
    const rate = mileage > 0 ? (energy / mileage) * 100 : null;
    return { dPct, energy, rate };
  }
  // 计算单条记录的电耗 (kWh/100km)：先查所属车辆取满电电量，再调 compute
  function rateOf(r) {
    const v = vehicles.find((x) => x.id === r.vehicleId);
    return compute(r.initPct, r.remainPct, v ? v.capacity : 0, r.mileage).rate;
  }

  // ---------- 数据加载 ----------
  async function loadData() {
    [vehicles, records] = await Promise.all([BatteryDB.getVehicles(), BatteryDB.getRecords()]);
    vehicles.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
    records.forEach((r) => {
      if (typeof r.ts !== 'number' || isNaN(r.ts)) r.ts = parseLocalDateTime(r.date).getTime();
    });
    records.sort((a, b) => (b.ts || 0) - (a.ts || 0)); // 时间戳降序，最新在前
    computeVehicleAvgs();
  }

  function computeVehicleAvgs() {
    vehicleAvg = {};
    const byV = {};
    records.forEach((r) => {
      const v = vehicles.find((x) => x.id === r.vehicleId);
      const c = compute(r.initPct, r.remainPct, v ? v.capacity : 0, r.mileage);
      const g = byV[r.vehicleId] = byV[r.vehicleId] || { e: 0, m: 0 };
      if (c.energy > 0 && c.rate != null) { g.e += c.energy; g.m += r.mileage; }
    });
    Object.keys(byV).forEach((vid) => {
      const g = byV[vid];
      vehicleAvg[vid] = g.m > 0 ? (g.e / g.m) * 100 : null;
    });
  }

  // ---------- 自定义确认弹窗 ----------
  function confirmDialog({ title = '提示', message = '', okText = '确定', cancelText = '取消', danger = false } = {}) {
    return new Promise((resolve) => {
      $('#confirm-title').textContent = title;
      $('#confirm-msg').textContent = message;
      const ok = $('#confirm-ok');
      ok.textContent = okText;
      ok.classList.toggle('danger', danger);
      $('#confirm-modal').hidden = false;
      const close = (val) => {
        $('#confirm-modal').hidden = true;
        ok.onclick = null;
        $('#confirm-cancel').onclick = null;
        resolve(val);
      };
      ok.onclick = () => close(true);
      $('#confirm-cancel').onclick = () => close(false);
    });
  }

  // ---------- 下载 ----------
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- 渲染：车辆下拉 ----------
  // 同步填充「记一笔」车辆下拉与列表顶部「筛选」下拉，并尽量保留用户原有选择
  function fillVehicleSelects() {
    const addSel = $('#add-vehicle');
    const filterSel = $('#filter-vehicle');
    const prevAdd = addSel.value;
    const prevFilter = filterSel.value;
    addSel.innerHTML = vehicles.map((v) => `<option value="${v.id}">${escapeHtml(v.name)}</option>`).join('');
    filterSel.innerHTML = '<option value="">全部车辆</option>' + vehicles.map((v) => `<option value="${v.id}">${escapeHtml(v.name)}</option>`).join('');
    if (prevAdd && vehicles.some((v) => v.id === prevAdd)) addSel.value = prevAdd;
    if (prevFilter && (prevFilter === '' || vehicles.some((v) => v.id === prevFilter))) filterSel.value = prevFilter;
  }

  // 切换车辆时：刷新满电电量展示，若初始电量未填则回填该车辆默认初始值，并触发实时计算
  function updateAddCapacity() {
    const v = vehicles.find((x) => x.id === $('#add-vehicle').value);
    if (v) {
      $('#add-capacity').textContent = fmt(v.capacity);
      if (!$('#add-init').value) $('#add-init').value = v.initPct != null ? v.initPct : '';
    } else {
      $('#add-capacity').textContent = '—';
    }
    recalc();
  }

  // ---------- 渲染：记录列表（分页 + 对比 + 语义色） ----------
  function renderRecords() {
    const list = $('#records-list');
    const filter = $('#filter-vehicle').value;
    const items = records.filter((r) => !filter || r.vehicleId === filter);
    $('#records-empty').hidden = items.length > 0;
    const shown = items.slice(0, recPage * REC_PAGE);
    list.innerHTML = shown
      .map((r) => {
        const v = vehicles.find((x) => x.id === r.vehicleId);
        const c = compute(r.initPct, r.remainPct, v ? v.capacity : 0, r.mileage);
        const ts = r.ts != null && !isNaN(r.ts) ? r.ts : parseLocalDateTime(r.date).getTime();
        const dateStr = dateToStr(ts) || escapeHtml(r.date);
        const rateTxt = c.rate == null ? '—' : fmt(c.rate);
        const warn = c.energy < 0 ? '<span class="rec-warn">（疑似充电）</span>' : '';

        // 与车辆历史平均电耗对比 + 颜色语义
        const avg = vehicleAvg[r.vehicleId];
        let rateClass = '', cmpTxt = '';
        if (c.rate != null && avg != null) {
          const diff = c.rate - avg;
          if (Math.abs(diff) <= Math.max(0.5, avg * 0.05)) { rateClass = 'rate-near'; cmpTxt = `接近平均 ${fmt(avg)}`; }
          else if (diff < 0) { rateClass = 'rate-good'; cmpTxt = `低于平均 ${fmt(avg)}`; }
          else { rateClass = 'rate-bad'; cmpTxt = `高于平均 ${fmt(avg)}`; }
        }
        const cmpHtml = c.rate != null && avg != null ? ` · 本次 <b class="${rateClass}">${rateTxt}</b>，${cmpTxt}` : '';

        return `
        <div class="rec-item">
          <div class="rec-top">
            <div class="rec-title">
              <span class="rec-dot"></span>
              <span class="rec-veh">${escapeHtml(v ? v.name : '未知车辆')}</span>
            </div>
            <button class="del-btn" data-del="${r.id}" aria-label="删除">✕</button>
          </div>
          <div class="rec-date">${dateStr}</div>
          <div class="rec-grid">
            <div class="rec-cell"><span>电量变化</span><b>${fmt(r.initPct)}→${fmt(r.remainPct)}%</b></div>
            <div class="rec-cell"><span>里程</span><b>${fmt(r.mileage)} km</b></div>
            <div class="rec-cell rate"><span>电耗</span><b class="${rateClass}">${rateTxt}</b></div>
          </div>
          <div class="rec-note">消耗 ${fmt(c.energy)} kWh ${warn}${cmpHtml}${r.note ? ' · ' + escapeHtml(r.note) : ''}</div>
        </div>`;
      })
      .join('');
    const hasMore = items.length > shown.length;
    $('#btn-loadmore').hidden = !hasMore;
    $('#records-end').hidden = !hasMore && items.length > 0;
    updateHero();
  }

  // 分页加载：当前页码 +1 后重渲染列表（每次多显示 REC_PAGE 条）
  function loadMore() { recPage += 1; renderRecords(); }

  function updateHero() {
    const totalMileage = records.reduce((s, r) => s + (Number(r.mileage) || 0), 0);
    const totalEnergy = records.reduce((s, r) => {
      const v = vehicles.find((x) => x.id === r.vehicleId);
      const c = compute(r.initPct, r.remainPct, v ? v.capacity : 0, r.mileage);
      return s + (c.energy > 0 ? c.energy : 0);
    }, 0);
    const avg = totalMileage > 0 ? (totalEnergy / totalMileage) * 100 : 0;
    $('#hero-count').textContent = records.length;
    $('#hero-rate').textContent = fmt(avg);
    $('#hero-mileage').textContent = fmt(totalMileage);
  }

  // ---------- 渲染：车辆列表 ----------
  function renderVehicles() {
    const list = $('#vehicles-list');
    if (!vehicles.length) {
      list.innerHTML = '<p class="empty-tip">还没有车辆，先在上面添加一辆。</p>';
      return;
    }
    list.innerHTML = vehicles
      .map(
        (v) => `
      <div class="veh-item">
        <div class="veh-info">
          <b>${escapeHtml(v.name)}</b>
          <span>满电 ${fmt(v.capacity)} kWh · 默认初始 ${fmt(v.initPct)}%</span>
        </div>
        <div class="veh-actions">
          <button class="edit" data-edit="${v.id}">编辑</button>
          <button class="del" data-delveh="${v.id}">删除</button>
        </div>
      </div>`
      )
      .join('');
  }

  // ---------- 渲染：统计 ----------
  function renderStats() {
    const totalMileage = records.reduce((s, r) => s + (Number(r.mileage) || 0), 0);
    const totalEnergy = records.reduce((s, r) => {
      const v = vehicles.find((x) => x.id === r.vehicleId);
      const c = compute(r.initPct, r.remainPct, v ? v.capacity : 0, r.mileage);
      return s + (c.energy > 0 ? c.energy : 0);
    }, 0);
    const avgRate = totalMileage > 0 ? (totalEnergy / totalMileage) * 100 : 0;

    $('#stat-mileage').textContent = fmt(totalMileage);
    $('#stat-energy').textContent = fmt(totalEnergy);
    $('#stat-rate').textContent = fmt(avgRate);
    $('#stat-count').textContent = records.length;

    const groups = {};
    records.forEach((r) => {
      const g = (groups[r.vehicleId] = groups[r.vehicleId] || { mileage: 0, energy: 0 });
      g.mileage += Number(r.mileage) || 0;
      const v = vehicles.find((x) => x.id === r.vehicleId);
      const c = compute(r.initPct, r.remainPct, v ? v.capacity : 0, r.mileage);
      if (c.energy > 0) g.energy += c.energy;
    });
    const box = $('#stat-by-vehicle');
    const entries = Object.entries(groups);
    if (!entries.length) { box.innerHTML = ''; return; }
    box.innerHTML = entries
      .map(([vid, g]) => {
        const v = vehicles.find((x) => x.id === vid);
        const rate = g.mileage > 0 ? (g.energy / g.mileage) * 100 : 0;
        return `
        <div class="stat-veh">
          <b>${escapeHtml(v ? v.name : '未知车辆')}</b>
          <div class="row"><span>里程</span><b>${fmt(g.mileage)} km</b></div>
          <div class="row"><span>耗电</span><b>${fmt(g.energy)} kWh</b></div>
          <div class="row"><span>平均电耗</span><b>${fmt(rate)} kWh/100km</b></div>
        </div>`;
      })
      .join('');
  }

  // ---------- 渲染：趋势图（纯 SVG，周/月切换） ----------
  function bucketKey(ts, mode) {
    const d = new Date(ts);
    if (mode === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const dt = new Date(d);
    const dw = (dt.getDay() + 6) % 7; // 周一为起点
    dt.setDate(dt.getDate() - dw);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }
  function bucketLabel(key, mode) {
    const p = key.split('-').map(Number);
    return mode === 'month' ? `${p[1]}月` : `${p[1]}/${p[2]}`;
  }
  function renderChart(mode) {
    const box = $('#chart');
    const recs = records
      .map((r) => ({ ts: r.ts, rate: rateOf(r) }))
      .filter((r) => r.rate != null)
      .sort((a, b) => a.ts - b.ts);
    if (!recs.length) { box.innerHTML = '<p class="empty-tip">暂无足够数据绘图</p>'; return; }

    const map = {};
    recs.forEach((r) => { const k = bucketKey(r.ts, mode); (map[k] = map[k] || []).push(r.rate); });
    const keys = Object.keys(map).sort();
    const data = keys.map((k) => ({ label: bucketLabel(k, mode), avg: map[k].reduce((s, x) => s + x, 0) / map[k].length }));

    const W = 680, H = 260, padL = 44, padR = 16, padT = 16, padB = 34;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const rates = data.map((d) => d.avg);
    let min = Math.min(...rates), max = Math.max(...rates);
    if (min === max) { min -= 1; max += 1; }
    const range = max - min;
    const x = (i) => padL + (data.length === 1 ? plotW / 2 : (plotW * i) / (data.length - 1));
    const y = (v) => padT + plotH - ((v - min) / range) * plotH;

    let grid = '';
    for (let g = 0; g <= 4; g++) {
      const gv = min + (range * g) / 4;
      const gy = y(gv);
      grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" class="ch-grid"/>`;
      grid += `<text x="${padL - 6}" y="${gy + 4}" class="ch-yl">${gv.toFixed(1)}</text>`;
    }
    let xlab = '';
    const step = Math.max(1, Math.ceil(data.length / 6));
    data.forEach((d, i) => { if (i % step === 0 || i === data.length - 1) xlab += `<text x="${x(i)}" y="${H - padB + 18}" class="ch-xl">${d.label}</text>`; });

    const linePts = data.map((d, i) => `${x(i)},${y(d.avg)}`).join(' ');
    const areaPts = `${padL},${y(min)} ` + linePts + ` ${x(data.length - 1)},${y(min)}`;
    let points = '';
    data.forEach((d, i) => { points += `<circle cx="${x(i)}" cy="${y(d.avg)}" r="3.5" class="ch-pt"/>`; });

    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" preserveAspectRatio="xMidYMid meet">
      ${grid}
      <polygon points="${areaPts}" class="ch-area"/>
      <polyline points="${linePts}" class="ch-line"/>
      ${points}
      ${xlab}
    </svg>`;
  }

  // ---------- 实时计算（记一笔） ----------
  function recalc() {
    const v = vehicles.find((x) => x.id === $('#add-vehicle').value);
    const cap = v ? v.capacity : 0;
    const init = parseFloat($('#add-init').value);
    const remain = parseFloat($('#add-remain').value);
    const mileage = parseFloat($('#add-mileage').value);
    const c = compute(init, remain, cap, mileage);
    $('#calc-energy').textContent = fmt(c.energy);
    $('#calc-rate').textContent = c.rate == null ? '—' : fmt(c.rate);
    const warnEl = $('#calc-warn');
    if (warnEl) warnEl.hidden = !(remain > init);
  }

  // ---------- 切换视图 ----------
  function switchView(name) {
    currentView = name;
    $$('.view').forEach((el) => (el.hidden = el.dataset.view !== name));
    $$('.tab').forEach((el) => el.classList.toggle('active', el.dataset.target === name));
    if (name === 'records') renderRecords();
    if (name === 'stats') { renderStats(); renderChart(currentChartMode); }
    window.scrollTo(0, 0);
  }

  // ---------- CSV 导入 / 导出 ----------
  function csvEscape(v) {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function parseCSV(text) {
    const rows = [];
    let row = [], cur = '', q = false, i = 0;
    text = text.replace(/\r\n?/g, '\n');
    while (i < text.length) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i += 2; continue; } q = false; i++; continue; }
        cur += ch; i++; continue;
      }
      if (ch === '"') { q = true; i++; continue; }
      if (ch === ',') { row.push(cur); cur = ''; i++; continue; }
      if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; i++; continue; }
      cur += ch; i++;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }
  function exportCSV() {
    const header = ['日期', '车辆', '满电电量(kWh)', '初始电量(%)', '剩余电量(%)', '里程(km)', '消耗(kWh)', '电耗(kWh/100km)', '备注'];
    const rows = [header];
    [...records].sort((a, b) => (a.ts || 0) - (b.ts || 0)).forEach((r) => {
      const v = vehicles.find((x) => x.id === r.vehicleId);
      const c = compute(r.initPct, r.remainPct, v ? v.capacity : 0, r.mileage);
      rows.push([dateToStr(r.ts != null && !isNaN(r.ts) ? r.ts : parseLocalDateTime(r.date).getTime()), v ? v.name : '', v ? v.capacity : '', r.initPct, r.remainPct, r.mileage, c.energy == null ? '' : fmt(c.energy), c.rate == null ? '' : fmt(c.rate), r.note || '']);
    });
    const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
    downloadBlob(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `电耗记录_${new Date().toISOString().slice(0, 10)}.csv`);
    toast('已导出 CSV');
  }
  async function importCSV(file) {
    const text = await file.text();
    const rows = parseCSV(text);
    if (rows.length < 2) { toast('CSV 无数据'); return; }
    const header = rows[0].map((h) => h.trim());
    const idx = (n) => header.indexOf(n);
    const iVeh = idx('车辆'), iInit = idx('初始电量(%)'), iRem = idx('剩余电量(%)'), iMil = idx('里程(km)'), iDate = idx('日期'), iCap = idx('满电电量(kWh)'), iNote = idx('备注');
    if (iVeh < 0 || iInit < 0 || iRem < 0 || iMil < 0) { toast('CSV 表头不匹配'); return; }
    const newVeh = [], toAdd = [];
    let skip = 0;
    for (let k = 1; k < rows.length; k++) {
      const row = rows[k];
      const vname = (row[iVeh] || '').trim();
      if (!vname) { skip++; continue; }
      let v = vehicles.find((x) => x.name === vname) || newVeh.find((x) => x.name === vname);
      if (!v) {
        const cap = parseFloat(row[iCap]);
        const nv = { id: uid(), name: vname, capacity: isNaN(cap) ? 60 : cap, initPct: 100 };
        newVeh.push(nv); v = nv;
      }
      const init = parseFloat(row[iInit]), rem = parseFloat(row[iRem]), mil = parseFloat(row[iMil]);
      if ([init, rem, mil].some(isNaN)) { skip++; continue; }
      const dateStr = (row[iDate] || '').trim();
      const ts = parseLocalDateTime(dateStr).getTime();
      toAdd.push({ id: uid(), vehicleId: v.id, date: dateStr || dateToStr(isNaN(ts) ? Date.now() : ts), ts: isNaN(ts) ? Date.now() : ts, initPct: init, remainPct: rem, mileage: mil, note: iNote >= 0 ? (row[iNote] || '').trim() : '', createdAt: new Date().toISOString() });
    }
    if (!toAdd.length) { toast('没有可导入的数据'); return; }
    if (!(await confirmDialog({ title: '导入 CSV', message: `将导入 ${toAdd.length} 条记录（合并到现有数据）${skip ? `，跳过 ${skip} 条` : ''}，继续？`, okText: '导入' }))) return;
    for (const v of newVeh) await BatteryDB.saveVehicle(v);
    for (const r of toAdd) await BatteryDB.saveRecord(r);
    await loadData();
    fillVehicleSelects();
    renderVehicles();
    recPage = 1; renderRecords();
    renderStats(); renderChart(currentChartMode);
    toast(`已导入 ${toAdd.length} 条${skip ? `，跳过 ${skip} 条` : ''}`);
  }

  // ---------- 报告长图（Canvas → PNG） ----------
  function roundRect(ctx, x, y, w, h, r) {
    if (h < 0) { y += h; h = -h; }
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function generateReport(period) {
    const now = new Date();
    let start, end, label, mode;
    if (period === 'month') {
      start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
      label = `${now.getFullYear()}年${now.getMonth() + 1}月`;
      mode = 'week';
    } else {
      start = new Date(now.getFullYear(), 0, 1).getTime();
      end = new Date(now.getFullYear() + 1, 0, 1).getTime();
      label = `${now.getFullYear()}年`;
      mode = 'month';
    }
    const recs = records.filter((r) => r.ts >= start && r.ts < end);
    if (!recs.length) { toast('该周期暂无记录'); return; }
    let totM = 0, totE = 0;
    const byV = {};
    recs.forEach((r) => {
      totM += Number(r.mileage) || 0;
      const v = vehicles.find((x) => x.id === r.vehicleId);
      const c = compute(r.initPct, r.remainPct, v ? v.capacity : 0, r.mileage);
      if (c.energy > 0) totE += c.energy;
      const g = byV[r.vehicleId] = byV[r.vehicleId] || { m: 0, e: 0 };
      g.m += Number(r.mileage) || 0;
      if (c.energy > 0) g.e += c.energy;
    });
    const avg = totM > 0 ? (totE / totM) * 100 : 0;

    const map = {};
    recs.forEach((r) => { const k = bucketKey(r.ts, mode); (map[k] = map[k] || []).push(rateOf(r)); });
    const bkeys = Object.keys(map).sort();
    const bars = bkeys.map((k) => ({ label: bucketLabel(k, mode), avg: map[k].reduce((s, x) => s + x, 0) / map[k].length }));

    const W = 1080, dpr = 2, pad = 48;
    const headH = 150, sumH = 150, vehH = Math.max(1, Object.keys(byV).length) * 54 + 40, chartH = 260, footH = 60;
    const H = headH + sumH + vehH + chartH + footH + pad;
    const cv = document.createElement('canvas');
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const dark = document.documentElement.dataset.theme === 'dark';
    const bg = dark ? '#0f172a' : '#ffffff';
    const fg = dark ? '#e2e8f0' : '#14202b';
    const sub = dark ? '#94a3b8' : '#6b7886';
    const card = dark ? '#1e293b' : '#f4f7fa';
    const line = dark ? '#334155' : '#e6ecf1';
    const accent = '#10b981';

    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = accent; ctx.fillRect(0, 0, W, 10);
    ctx.fillStyle = fg; ctx.textBaseline = 'top'; ctx.font = '800 46px sans-serif';
    ctx.fillText('电车电耗报告', pad, 40);
    ctx.fillStyle = sub; ctx.font = '600 26px sans-serif';
    ctx.fillText(label + ' · 用车概览', pad, 100);
    ctx.textAlign = 'right'; ctx.fillStyle = sub; ctx.font = '500 22px sans-serif';
    ctx.fillText('生成于 ' + now.toLocaleDateString('zh-CN'), W - pad, 108); ctx.textAlign = 'left';

    const cards = [['总里程', fmt(totM) + ' km'], ['总耗电', fmt(totE) + ' kWh'], ['平均电耗', fmt(avg)], ['记录数', recs.length + ' 条']];
    const cw = (W - pad * 2 - 30) / 4;
    let cx = pad;
    const cy = headH + 10;
    cards.forEach((c, i) => {
      ctx.fillStyle = card; roundRect(ctx, cx, cy, cw, sumH - 20, 16); ctx.fill();
      ctx.fillStyle = sub; ctx.font = '600 22px sans-serif'; ctx.fillText(c[0], cx + 18, cy + 22);
      ctx.fillStyle = i === 2 ? accent : fg; ctx.font = '800 38px sans-serif'; ctx.fillText(c[1], cx + 18, cy + 62);
      cx += cw + 10;
    });

    let vy = headH + sumH + 10;
    ctx.fillStyle = fg; ctx.font = '800 28px sans-serif'; ctx.fillText('各车辆表现', pad, vy); vy += 44;
    Object.keys(byV).forEach((vid) => {
      const g = byV[vid];
      const v = vehicles.find((x) => x.id === vid);
      const ra = g.m > 0 ? (g.e / g.m) * 100 : 0;
      ctx.fillStyle = card; roundRect(ctx, pad, vy, W - pad * 2, 44, 12); ctx.fill();
      ctx.fillStyle = fg; ctx.font = '700 24px sans-serif'; ctx.fillText(v ? v.name : '未知', pad + 18, vy + 10);
      ctx.fillStyle = accent; ctx.textAlign = 'right'; ctx.fillText(`${fmt(ra)} kWh/100km`, W - pad - 18, vy + 10); ctx.textAlign = 'left';
      vy += 54;
    });

    let chy = vy + 6;
    ctx.fillStyle = fg; ctx.font = '800 28px sans-serif'; ctx.fillText(period === 'month' ? '按周平均电耗' : '按月平均电耗', pad, chy); chy += 44;
    const chartX = pad, chartW = W - pad * 2, chartY = chy, chartH2 = chartH - 40;
    const rates = bars.map((b) => b.avg);
    let mn = Math.min(...rates), mx = Math.max(...rates);
    if (mn === mx) { mn -= 1; mx += 1; }
    const rg = mx - mn;
    ctx.strokeStyle = line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(chartX, chartY + chartH2); ctx.lineTo(chartX + chartW, chartY + chartH2); ctx.stroke();
    const bw = chartW / Math.max(1, bars.length);
    bars.forEach((b, i) => {
      const h = ((b.avg - mn) / rg) * (chartH2 - 20);
      const bx = chartX + i * bw + 8, bwid = bw - 16, by = chartY + chartH2 - h;
      const grad = ctx.createLinearGradient(0, by, 0, by + h);
      grad.addColorStop(0, accent); grad.addColorStop(1, dark ? '#065f46' : '#a7f3d0');
      ctx.fillStyle = grad; roundRect(ctx, bx, by, bwid, h, 6); ctx.fill();
      ctx.fillStyle = sub; ctx.font = '500 18px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(b.label, bx + bwid / 2, chartY + chartH2 + 8); ctx.textAlign = 'left';
    });

    ctx.fillStyle = sub; ctx.font = '500 20px sans-serif';
    ctx.fillText('电车电耗记录 · 数据完全本地保存', pad, H - footH + 20);

    cv.toBlob((blob) => {
      if (blob) { downloadBlob(blob, `电耗报告_${label}.png`); toast('报告长图已生成'); }
    }, 'image/png');
  }

  // ---------- 主题（深色模式） ----------
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('battery-theme', t); } catch (e) {}
    const btn = $('#btn-theme');
    if (btn) btn.textContent = t === 'dark' ? '☀️' : '🌙';
  }

  // ---------- 下拉刷新 / 上拉加载 ----------
  let ptr = { startY: 0, pulling: false, dist: 0 };
  function onPtrStart(e) { if (window.scrollY <= 0) { ptr.startY = e.touches[0].clientY; ptr.pulling = true; } }
  function onPtrMove(e) {
    if (!ptr.pulling) return;
    const dy = e.touches[0].clientY - ptr.startY;
    if (dy <= 0) { ptr.pulling = false; $('#ptr').style.height = '0px'; return; }
    ptr.dist = Math.min(dy, 90);
    $('#ptr').style.height = ptr.dist + 'px';
    $('.ptr-text', $('#ptr')).textContent = ptr.dist > 55 ? '释放刷新' : '下拉刷新';
    if (e.cancelable) e.preventDefault();
  }
  function onPtrEnd() {
    if (!ptr.pulling) return;
    if (ptr.dist > 55) refreshRecords();
    ptr.pulling = false; ptr.dist = 0;
    $('#ptr').style.height = '0px';
    $('.ptr-text', $('#ptr')).textContent = '下拉刷新';
  }
  async function refreshRecords() {
    await loadData();
    fillVehicleSelects();
    renderVehicles();
    recPage = 1; renderRecords();
    renderStats(); renderChart(currentChartMode);
    toast('已刷新');
  }
  let scrollLock = false;
  function onScroll() {
    if (currentView !== 'records' || scrollLock) return;
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 300) {
      const filter = $('#filter-vehicle').value;
      const total = records.filter((r) => !filter || r.vehicleId === filter).length;
      if (total > recPage * REC_PAGE) { scrollLock = true; loadMore(); setTimeout(() => (scrollLock = false), 400); }
    }
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    $$('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.target)));

    // 主题
    $('#btn-theme').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

    // 记录列表：刷新 / 筛选 / 加载更多 / 下拉刷新 / 滚动加载
    $('#btn-refresh').addEventListener('click', refreshRecords);
    $('#filter-vehicle').addEventListener('change', () => { recPage = 1; renderRecords(); });
    $('#btn-loadmore').addEventListener('click', loadMore);
    $('.ptr-wrap').addEventListener('touchstart', onPtrStart, { passive: true });
    $('.ptr-wrap').addEventListener('touchmove', onPtrMove, { passive: false });
    $('.ptr-wrap').addEventListener('touchend', onPtrEnd);
    window.addEventListener('scroll', onScroll, { passive: true });

    // 记一笔表单
    $('#add-vehicle').addEventListener('change', updateAddCapacity);
    ['#add-init', '#add-remain', '#add-mileage'].forEach((s) => $(s).addEventListener('input', recalc));
    $('#add-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = vehicles.find((x) => x.id === $('#add-vehicle').value);
      if (!v) { toast('请先添加车辆'); return; }
      const init = parseFloat($('#add-init').value);
      const remain = parseFloat($('#add-remain').value);
      const mileage = parseFloat($('#add-mileage').value);
      if (isNaN(init) || isNaN(remain) || isNaN(mileage)) { toast('请填写完整数字'); return; }
      // 公式校验：初始必须高于剩余，杜绝负电耗
      if (remain > init) { toast('初始电量需高于剩余电量，请检查输入'); return; }
      if (mileage <= 0) { toast('行驶里程需大于 0'); return; }
      const recDate = $('#add-date').value || nowLocalInput();
      const rec = {
        id: uid(),
        vehicleId: v.id,
        date: recDate,
        ts: parseLocalDateTime(recDate).getTime(),
        initPct: init,
        remainPct: remain,
        mileage: mileage,
        note: $('#add-note').value.trim(),
        createdAt: new Date().toISOString(),
      };
      await BatteryDB.saveRecord(rec);
      await loadData();
      fillVehicleSelects();
      recPage = 1; renderRecords();
      renderStats(); renderChart(currentChartMode);
      $('#add-note').value = '';
      toast('已保存');
      switchView('records');
    });

    // 记录删除（事件委托 + 二次确认）
    $('#records-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-del]');
      if (!btn) return;
      if (!(await confirmDialog({ title: '删除记录', message: '确定删除这条记录？', okText: '删除', danger: true }))) return;
      await BatteryDB.deleteRecord(btn.dataset.del);
      await loadData();
      recPage = 1; renderRecords();
      renderStats(); renderChart(currentChartMode);
      toast('已删除');
    });

    // 车辆表单
    $('#vehicle-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#veh-name').value.trim();
      const capacity = parseFloat($('#veh-capacity').value);
      const init = parseFloat($('#veh-init').value);
      if (!name) { toast('请填写名称'); return; }
      if (isNaN(capacity) || capacity <= 0) { toast('请填写有效满电电量'); return; }
      if (isNaN(init) || init < 0 || init > 100) { toast('默认初始电量需在 0-100'); return; }
      const id = $('#veh-id').value || uid();
      const veh = { id, name, capacity, initPct: init };
      await BatteryDB.saveVehicle(veh);
      await loadData();
      fillVehicleSelects();
      renderVehicles();
      resetVehicleForm();
      toast('车辆已保存');
    });
    $('#veh-reset').addEventListener('click', resetVehicleForm);

    $('#vehicles-list').addEventListener('click', async (e) => {
      const editBtn = e.target.closest('[data-edit]');
      const delBtn = e.target.closest('[data-delveh]');
      if (editBtn) {
        const v = vehicles.find((x) => x.id === editBtn.dataset.edit);
        if (v) {
          $('#veh-id').value = v.id;
          $('#veh-name').value = v.name;
          $('#veh-capacity').value = v.capacity;
          $('#veh-init').value = v.initPct;
          $('#veh-submit').textContent = '更新车辆';
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      }
      if (delBtn) {
        const v = vehicles.find((x) => x.id === delBtn.dataset.delveh);
        const used = records.filter((r) => r.vehicleId === delBtn.dataset.delveh).length;
        const msg = used ? `删除「${v ? v.name : ''}」会同时删除其 ${used} 条记录，确定？` : '确定删除这辆车？';
        if (!(await confirmDialog({ title: '删除车辆', message: msg, okText: '删除', danger: true }))) return;
        await BatteryDB.deleteVehicle(delBtn.dataset.delveh);
        const rel = records.filter((r) => r.vehicleId === delBtn.dataset.delveh);
        await Promise.all(rel.map((r) => BatteryDB.deleteRecord(r.id)));
        await loadData();
        fillVehicleSelects();
        renderVehicles();
        recPage = 1; renderRecords();
        renderStats(); renderChart(currentChartMode);
        toast('已删除');
      }
    });

    // 统计：趋势图切换
    $$('#chart-toggle button').forEach((b) => b.addEventListener('click', () => {
      $$('#chart-toggle button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      currentChartMode = b.dataset.chart;
      renderChart(currentChartMode);
    }));

    // 备份：导出 JSON
    $('#btn-export').addEventListener('click', async () => {
      const data = await BatteryDB.exportAll();
      downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `电耗记录备份_${new Date().toISOString().slice(0, 10)}.json`);
      toast('已导出到下载目录');
    });
    // 备份：导出 CSV
    $('#btn-export-csv').addEventListener('click', exportCSV);

    // 备份：导入 JSON（合并）
    $('#btn-import').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (data.app !== 'battery-logger' || !Array.isArray(data.vehicles) || !Array.isArray(data.records)) { toast('文件格式不正确'); e.target.value = ''; return; }
        if (!(await confirmDialog({ title: '导入备份', message: `将导入 ${data.vehicles.length} 辆车、${data.records.length} 条记录（合并到现有数据），继续？`, okText: '导入' }))) { e.target.value = ''; return; }
        const res = await BatteryDB.mergeImport(data);
        await loadData();
        fillVehicleSelects();
        renderVehicles();
        recPage = 1; renderRecords();
        renderStats(); renderChart(currentChartMode);
        toast(`已导入 ${res.vehicles} 车 / ${res.records} 记录`);
      } catch (err) { toast('导入失败：' + err.message); }
      e.target.value = '';
    });

    // 备份：导入 CSV（合并）
    $('#btn-import-csv').addEventListener('click', () => $('#import-csv-file').click());
    $('#import-csv-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) await importCSV(file);
      e.target.value = '';
    });

    // 报告长图
    $('#btn-report-month').addEventListener('click', () => generateReport('month'));
    $('#btn-report-year').addEventListener('click', () => generateReport('year'));

    // 备份：清空（二次确认）
    $('#btn-clear').addEventListener('click', async () => {
      if (!(await confirmDialog({ title: '清空全部数据', message: '将删除本机全部车辆与记录，且不可恢复。确定清空？', okText: '清空', danger: true }))) return;
      await BatteryDB.clearAll();
      await loadData();
      fillVehicleSelects();
      renderVehicles();
      recPage = 1; renderRecords();
      renderStats(); renderChart(currentChartMode);
      toast('已清空');
    });

    // 安装到主屏幕
    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', (ev) => {
      ev.preventDefault();
      deferredPrompt = ev;
      $('#install-tip').hidden = false;
    });
    $('#btn-install').addEventListener('click', async () => {
      if (!deferredPrompt) { toast('请使用浏览器菜单「添加到主屏幕」'); return; }
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      $('#install-tip').hidden = true;
    });
  }

  // 清空车辆表单（含隐藏的编辑态 id），并把提交按钮文案恢复为「保存车辆」
  function resetVehicleForm() {
    $('#veh-id').value = '';
    $('#veh-name').value = '';
    $('#veh-capacity').value = '';
    $('#veh-init').value = '';
    $('#veh-submit').textContent = '保存车辆';
  }

  // 无车辆时禁用「记一笔」表单并提示先添加车辆；有车辆时恢复并刷新满电电量
  function refreshAddState() {
    const has = vehicles.length > 0;
    $('#add-vehicle').disabled = !has;
    $('#no-vehicle-tip').hidden = has;
    $('#add-submit').disabled = !has;
    if (has) updateAddCapacity();
  }

  // ---------- 初始化 ----------
  async function init() {
    // 主题（在渲染前应用，避免闪烁）
    let saved = 'light';
    try { saved = localStorage.getItem('battery-theme') || 'light'; } catch (e) {}
    applyTheme(saved);

    if ('serviceWorker' in navigator) {
      try { await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn('SW 注册失败', e); }
    }

    await loadData();
    fillVehicleSelects();
    $('#add-date').value = nowLocalInput();
    renderVehicles();
    recPage = 1; renderRecords();
    renderStats();
    refreshAddState();
    bindEvents();
    switchView('records');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
