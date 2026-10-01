'use strict';

// ================= 状态 =================

const state = {
  draft: null,          // GET /designs/:id 返回
  drawing: null,        // { points:[[x,y]...] } 正在绘制的多边形
  editingId: null,      // 正在编辑（拖拽）的拼片 id
  error: null,          // { message, at, category, pieceId }
  showGaps: true,
};

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// ================= API =================

async function api(method, url, body) {
  const resp = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await resp.json(); } catch (_) { /* ignore */ }
  if (!resp.ok || (data && data.ok === false)) {
    const err = new Error(data?.error || `请求失败 (${resp.status})`);
    err.data = data || {};
    err.status = resp.status;
    throw err;
  }
  return data;
}

// ================= 坐标变换 =================

function getTransform(draft, cv) {
  const pad = 40;
  const sx = (cv.width - pad * 2) / draft.width;
  const sy = (cv.height - pad * 2) / draft.height;
  const scale = Math.min(sx, sy);
  const ox = (cv.width - draft.width * scale) / 2;
  const oy = (cv.height - draft.height * scale) / 2;
  return {
    scale, ox, oy,
    toPx: (x, y) => [ox + x * scale, cv.height - (oy + y * scale)],
    toMm: (px, py) => [
      Math.round((px - ox) / scale),
      Math.round((cv.height - py - oy) / scale),
    ],
  };
}

// ================= 草稿渲染 =================

function renderDraft() {
  const d = state.draft;
  const banner = document.getElementById('errorBanner');
  if (!d) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    banner.hidden = true;
    return;
  }
  const t = getTransform(d, canvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 背景
  ctx.fillStyle = '#fbfaf7';
  ctx.fillRect(...t.toPx(0, d.height), d.width * t.scale, d.height * t.scale);

  // 缺口（红色斜纹，含“孤岛片”形成的带洞缺口）
  if (state.showGaps && !d.coverage.covered) {
    for (const gap of d.coverage.gaps) drawGap(gap, t);
    for (const ov of d.coverage.overlapping) drawOverlap(ov, t);
  }

  // 玻璃片
  for (const pc of d.pieces) drawPiece(pc, t);

  // 外框
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 3;
  ctx.strokeRect(...t.toPx(0, d.height), d.width * t.scale, d.height * t.scale);

  // 正在绘制的多边形
  if (state.drawing) drawInProgress(t);

  // 错误位置标记
  if (state.error?.at) drawErrorMarker(state.error.at, t);

  renderPieceList();
  renderCoverage();
  renderLeadList();
}

function drawPiece(pc, t) {
  const pts = pc.polygon.map(([x, y]) => t.toPx(x, y));
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = pc.color;
  ctx.globalAlpha = 0.78;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // 编号 + 面积，写在面积中心
  const [cx0, cy0] = centroid(pc.polygon);
  const [cx, cy] = t.toPx(cx0, cy0);
  const label = `#${pc.pieceNo} ${pc.area}mm²`;
  ctx.font = 'bold 13px sans-serif';
  const w = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fillRect(cx - w / 2 - 4, cy - 10, w + 8, 18);
  ctx.fillStyle = '#111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, cx, cy);
}

function centroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += f;
    cx += (poly[j][0] + poly[i][0]) * f;
    cy += (poly[j][1] + poly[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const sx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
    const sy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    return [sx, sy];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

function tracePath(rings, t) {
  ctx.beginPath();
  for (const ring of rings) {
    const pts = ring.map(([x, y]) => t.toPx(x, y));
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  }
}

function drawGap(gap, t) {
  const rings = [gap.outer || gap.polygon, ...(gap.holes || [])];
  tracePath(rings, t);
  ctx.fillStyle = 'rgba(210, 40, 30, 0.18)';
  ctx.fill('evenodd');
  ctx.save();
  ctx.clip('evenodd');
  ctx.strokeStyle = 'rgba(210, 40, 30, 0.55)';
  ctx.lineWidth = 2;
  for (let k = -600; k < 600; k += 10) {
    ctx.beginPath();
    ctx.moveTo(k, 0);
    ctx.lineTo(k + 600, 600);
    ctx.stroke();
  }
  ctx.restore();
  tracePath(rings, t);
  ctx.strokeStyle = '#c0281c';
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawOverlap(ov, t) {
  tracePath([ov.polygon], t);
  ctx.fillStyle = 'rgba(160, 0, 200, 0.2)';
  ctx.fill();
  ctx.strokeStyle = '#8b00b8';
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawInProgress(t) {
  const pts = state.drawing.points;
  if (!pts.length) return;
  const px = pts.map(([x, y]) => t.toPx(x, y));
  if (px.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(px[0][0], px[0][1]);
    for (let i = 1; i < px.length; i++) ctx.lineTo(px[i][0], px[i][1]);
    ctx.strokeStyle = '#1565c0';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  px.forEach(([x, y], i) => {
    ctx.beginPath();
    ctx.arc(x, y, i === 0 ? 5 : 4, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? '#1565c0' : '#fff';
    ctx.fill();
    ctx.strokeStyle = '#1565c0';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#1565c0';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${i + 1}(${pts[i][0]},${pts[i][1]})`, x + 7, y - 7);
  });
}

function drawErrorMarker(at, t) {
  const [x, y] = t.toPx(at[0], at[1]);
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, Math.PI * 2);
  ctx.strokeStyle = '#d32f2f';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5);
  ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5);
  ctx.strokeStyle = '#d32f2f';
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

// ================= 画布交互：绘制 =================

canvas.addEventListener('mousemove', (e) => {
  if (!state.draft) return;
  const t = getTransform(state.draft, canvas);
  const rect = canvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (canvas.width / rect.width);
  const py = (e.clientY - rect.top) * (canvas.height / rect.height);
  const [x, y] = t.toMm(px, py);
  const inside = x >= 0 && y >= 0 && x <= state.draft.width && y <= state.draft.height;
  document.getElementById('cursorPos').textContent =
    `光标坐标: ${inside ? `${x}, ${y} mm` : '（窗框外）'}`;
});

canvas.addEventListener('click', (e) => {
  if (!state.draft || !state.drawing) return;
  const t = getTransform(state.draft, canvas);
  const rect = canvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (canvas.width / rect.width);
  const py = (e.clientY - rect.top) * (canvas.height / rect.height);
  const [x, y] = t.toMm(px, py);
  if (x < 0 || y < 0 || x > state.draft.width || y > state.draft.height) {
    showError({ error: '顶点越出窗框', at: [x, y] });
    return;
  }
  // 吸附到已有顶点（8px 内），便于精确 T 接
  const snap = snapToVertex(x, y, t);
  state.drawing.points.push(snap || [x, y]);
  clearError();
  syncCoordsText();
  renderDraft();
});

canvas.addEventListener('dblclick', () => {
  if (state.drawing) finishDrawing();
});

function snapToVertex(x, y, t) {
  let best = null, bestD = 8;
  const consider = (vx, vy) => {
    const [px, py] = t.toPx(vx, vy);
    const [cx, cy] = t.toPx(x, y);
    const d = Math.hypot(px - cx, py - cy);
    if (d < bestD) { bestD = d; best = [vx, vy]; }
  };
  for (const pc of state.draft.pieces) pc.polygon.forEach((p) => consider(p[0], p[1]));
  [[0, 0], [state.draft.width, 0], [state.draft.width, state.draft.height], [0, state.draft.height]]
    .forEach((c) => consider(c[0], c[1]));
  state.drawing?.points.forEach((p) => consider(p[0], p[1]));
  return best;
}

function startDrawing() {
  state.drawing = { points: [] };
  document.getElementById('editHint').textContent = '在画布上依次点击顶点（自动吸附已有顶点），双击或点“闭合多边形”完成。';
  syncCoordsText();
  renderDraft();
}

function finishDrawing() {
  if (!state.drawing) return;
  const pts = state.drawing.points;
  if (pts.length < 3) {
    showError({ error: '多边形至少需要 3 个顶点' });
    return;
  }
  submitPiece(pts);
}

async function submitPiece(polygon) {
  const color = document.getElementById('pieceColor').value;
  const wasEditing = state.editingId !== null;
  try {
    const data = wasEditing
      ? await api('PUT', `/api/designs/${state.draft.id}/pieces/${state.editingId}`, { color, polygon })
      : await api('POST', `/api/designs/${state.draft.id}/pieces`, { color, polygon });
    state.draft = data.draft;
    state.drawing = null;
    state.editingId = null;
    document.getElementById('coordsInput').value = '';
    document.getElementById('editHint').textContent = '';
    showSuccess(wasEditing ? '拼片已更新' : '拼片已加入草稿');
    renderAllDraft();
  } catch (err) {
    showError(err.data?.error ? err.data : { error: err.message, at: err.data?.at });
  }
}

function cancelDrawing() {
  state.drawing = null;
  state.editingId = null;
  document.getElementById('coordsInput').value = '';
  document.getElementById('editHint').textContent = '';
  clearError();
  renderDraft();
}

function syncCoordsText() {
  if (!state.drawing) return;
  document.getElementById('coordsInput').value =
    state.drawing.points.map((p) => p.join(',')).join('\n');
}

// 手工坐标 → 开始绘制状态（供预览/提交）
function coordsFromTextarea() {
  const lines = document.getElementById('coordsInput').value
    .split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
  const pts = [];
  for (const line of lines) {
    const m = line.match(/^(-?\d+)\s*[,，\s]\s*(-?\d+)$/);
    if (!m) return { error: `无法解析坐标行: “${line}”` };
    pts.push([Number(m[1]), Number(m[2])]);
  }
  return { points: pts };
}

// ================= 侧栏列表与状态 =================

function renderPieceList() {
  const d = state.draft;
  document.getElementById('pieceCount').textContent = d.pieces.length;
  const ul = document.getElementById('pieceList');
  ul.innerHTML = '';
  for (const pc of d.pieces) {
    const li = document.createElement('li');
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = pc.color;
    const meta = document.createElement('span');
    meta.className = 'piece-meta';
    meta.innerHTML = `<span class="no">#${pc.pieceNo}</span><span class="area">${pc.area} mm²</span><br>
      <span class="small muted">${pc.polygon.length} 顶点</span>`;
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'color-pick';
    colorInput.value = pc.color;
    colorInput.title = '改颜色';
    colorInput.addEventListener('change', () => recolor(pc.id, colorInput.value));
    const editBtn = document.createElement('button');
    editBtn.className = 'icon-btn';
    editBtn.title = '编辑顶点（载入到画布）';
    editBtn.textContent = '✏️';
    editBtn.addEventListener('click', () => editPiece(pc));
    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn danger';
    delBtn.title = '删除';
    delBtn.textContent = '🗑';
    delBtn.addEventListener('click', () => removePiece(pc.id));
    li.append(sw, meta, colorInput, editBtn, delBtn);
    ul.appendChild(li);
  }
}

async function recolor(id, color) {
  const pc = state.draft.pieces.find((p) => p.id === id);
  try {
    const data = await api('PUT', `/api/designs/${state.draft.id}/pieces/${id}`,
      { color, polygon: pc.polygon });
    state.draft = data.draft;
    renderAllDraft();
  } catch (err) {
    showError(err.data?.error ? err.data : { error: err.message });
  }
}

function editPiece(pc) {
  state.editingId = pc.id;
  state.drawing = { points: pc.polygon.map((p) => p.slice()) };
  document.getElementById('pieceColor').value = pc.color;
  syncCoordsText();
  document.getElementById('editHint').textContent =
    `正在编辑 #${pc.pieceNo}：可修改坐标文本后“闭合多边形”保存，或取消放弃。`;
  renderDraft();
}

async function removePiece(id) {
  if (!confirm('确定删除这片拼片？（仅影响草稿）')) return;
  try {
    const data = await api('DELETE', `/api/designs/${state.draft.id}/pieces/${id}`);
    state.draft = data.draft;
    renderAllDraft();
  } catch (err) {
    showError({ error: err.message });
  }
}

function renderCoverage() {
  const c = state.draft.coverage;
  const box = document.getElementById('coverageStatus');
  if (c.covered) {
    box.innerHTML = `<span class="badge ok">✓ 完整覆盖，无空隙</span>
      <div class="muted">玻璃总面积 ${c.totalPieceArea} mm² ＝ 窗框面积 ${c.frameArea} mm²，可以发布。</div>`;
  } else {
    let html = `<span class="badge bad">✗ 尚未完整覆盖</span>`;
    if (c.gaps.length) {
      html += `<div class="gap-info">检测到 ${c.gaps.length} 个缺口（图中红色斜纹）：<br>` +
        c.gaps.map((g, i) => `缺口${i + 1}：面积 ${g.area} mm²`).join('<br>') + '</div>';
    }
    if (c.overlapping.length) {
      html += `<div class="gap-info">存在 ${c.overlapping.length} 处面积重叠（紫色区域），发布前必须修正。</div>`;
    }
    html += `<div class="muted">已覆盖 ${c.totalPieceArea} / ${c.frameArea} mm²</div>`;
    box.innerHTML = html;
  }
}

function renderLeadList() {
  const L = state.draft.leadList;
  const el = document.getElementById('leadList');
  let html = '<table><thead><tr><th>#</th><th>起点→终点</th><th class="num">长度 mm</th></tr></thead><tbody>';
  L.internal.forEach((r) => {
    const a = r.points[0], b = r.points[r.points.length - 1];
    html += `<tr><td>${r.no}</td><td>(${a[0]},${a[1]}) → (${b[0]},${b[1]})${r.points.length > 2 ? ` <span class="muted">(${r.points.length - 1} 段合并)</span>` : ''}</td><td class="num">${fmt(r.length)}</td></tr>`;
  });
  html += `<tr class="totals"><td colspan="2">内部公共边小计（${L.internalCount} 根）</td><td class="num">${fmt(L.internalTotal)}</td></tr>`;
  html += '</tbody></table>';
  html += '<table><thead><tr><th>外框</th><th class="num">长度 mm</th></tr></thead><tbody>';
  L.frameBars.forEach((b) => {
    html += `<tr><td>${b.name}</td><td class="num">${fmt(b.length)}</td></tr>`;
  });
  html += `<tr class="totals"><td>外框小计（4 根）</td><td class="num">${fmt(L.frameTotal)}</td></tr>`;
  html += `<tr class="totals"><td>铅条总长</td><td class="num">${fmt(L.grandTotal)}</td></tr>`;
  html += '</tbody></table>';
  html += '<div class="hint">公共边无论一侧整边、另一侧分几段，均合并为一根只计一次；长度先求和再四舍五入到 0.01 mm。</div>';
  el.innerHTML = html;
}

const fmt = (v) => (Math.round(v * 100) / 100).toFixed(2);

// ================= 横幅 =================

let bannerTimer = null;
function showError(payload) {
  state.error = payload;
  const b = document.getElementById('errorBanner');
  b.className = 'banner error';
  b.hidden = false;
  let txt = `⛔ ${payload.error}`;
  if (payload.at) txt += `　位置：(${payload.at[0]}, ${payload.at[1]}) mm`;
  if (payload.gaps?.length) txt += `<br>缺口面积：${payload.gaps.map((g) => g.area).join('、')} mm²`;
  b.innerHTML = txt;
  renderDraft();
}
function showSuccess(msg) {
  clearError();
  const b = document.getElementById('errorBanner');
  b.className = 'banner success';
  b.hidden = false;
  b.textContent = '✓ ' + msg;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { b.hidden = true; }, 2500);
}
function clearError() {
  state.error = null;
  document.getElementById('errorBanner').hidden = true;
}

// ================= 图纸加载 / 新建 =================

async function loadDraft(id) {
  cancelDrawing();
  const data = await api('GET', `/api/designs/${id}`);
  state.draft = data.draft;
  document.getElementById('designMeta').innerHTML =
    `<b>${escapeHtml(data.draft.name)}</b><br>窗框 ${data.draft.width} × ${data.draft.height} mm`;
  document.getElementById('editSection').hidden = false;
  document.getElementById('pieceListSection').hidden = false;
  document.getElementById('statusSection').hidden = false;
  state.drawing = null;
  renderAllDraft();
}

function renderAllDraft() {
  document.getElementById('designSelect').value = state.draft.id;
  renderDraft();
}

async function refreshDesignSelect(selectId, selectId2) {
  const data = await api('GET', '/api/designs');
  for (const id of [selectId, selectId2].filter(Boolean)) {
    const sel = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = '';
    for (const d of data.designs) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.name}（${d.width}×${d.height}mm）`;
      sel.appendChild(opt);
    }
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }
  return data.designs;
}

async function createDesign() {
  const name = document.getElementById('newName').value;
  const width = Number(document.getElementById('newWidth').value);
  const height = Number(document.getElementById('newHeight').value);
  try {
    const data = await api('POST', '/api/designs', { name, width, height });
    await refreshDesignSelect('designSelect', 'pubDesignSelect');
    document.getElementById('designSelect').value = data.design.id;
    await loadDraft(data.design.id);
  } catch (err) {
    alert(err.message);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ================= 发布 =================

async function publishDraft() {
  try {
    const data = await api('POST', `/api/designs/${state.draft.id}/publish`);
    showSuccess(`已发布为 v${data.publication.version}（历史版本不可修改）`);
  } catch (err) {
    const d = err.data || {};
    showError({
      error: d.error || err.message,
      gaps: d.gaps,
      at: d.gaps?.[0]?.polygon?.[0] || null,
    });
  }
}

// ================= 已发布视图 =================

const pubCanvas = document.getElementById('pubCanvas');
const pubCtx = pubCanvas.getContext('2d');
let currentPub = null;

async function loadPubDesignOptions() {
  await refreshDesignSelect('designSelect', 'pubDesignSelect');
  await loadPubVersions();
}

async function loadPubVersions() {
  const id = document.getElementById('pubDesignSelect').value;
  if (!id) return;
  const data = await api('GET', `/api/designs/${id}/publications`);
  const sel = document.getElementById('pubVersionSelect');
  sel.innerHTML = '';
  if (!data.publications.length) {
    sel.innerHTML = '<option value="">（暂无发布版）</option>';
    currentPub = null;
    renderPublished();
    return;
  }
  for (const p of data.publications) {
    const opt = document.createElement('option');
    opt.value = p.version;
    opt.textContent = `v${p.version} · ${p.publishedAt}`;
    sel.appendChild(opt);
  }
  await loadPubVersion(sel.value);
}

async function loadPubVersion(version) {
  const id = document.getElementById('pubDesignSelect').value;
  if (!id || !version) { currentPub = null; renderPublished(); return; }
  const data = await api('GET', `/api/designs/${id}/publications/${version}`);
  currentPub = data.publication;
  renderPublished();
}

function renderPublished() {
  pubCtx.clearRect(0, 0, pubCanvas.width, pubCanvas.height);
  document.getElementById('pubPieceList').innerHTML = '';
  document.getElementById('pubLeadList').innerHTML = '';
  document.getElementById('pubMeta').textContent = '';
  if (!currentPub) return;
  const { snapshot: s } = currentPub;
  const t = getTransform(s, pubCanvas);

  pubCtx.fillStyle = '#fbfaf7';
  pubCtx.fillRect(...t.toPx(0, s.height), s.width * t.scale, s.height * t.scale);
  for (const pc of s.pieces) {
    const pts = pc.polygon.map(([x, y]) => t.toPx(x, y));
    pubCtx.beginPath();
    pubCtx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) pubCtx.lineTo(pts[i][0], pts[i][1]);
    pubCtx.closePath();
    pubCtx.fillStyle = pc.color;
    pubCtx.globalAlpha = 0.82;
    pubCtx.fill();
    pubCtx.globalAlpha = 1;
    pubCtx.strokeStyle = '#222';
    pubCtx.lineWidth = 2;
    pubCtx.stroke();
    const [cx0, cy0] = centroid(pc.polygon);
    const [cx, cy] = t.toPx(cx0, cy0);
    pubCtx.font = 'bold 13px sans-serif';
    const label = `#${pc.pieceNo}`;
    const area = `${pc.area} mm²`;
    pubCtx.textAlign = 'center';
    pubCtx.textBaseline = 'middle';
    pubCtx.fillStyle = 'rgba(255,255,255,0.8)';
    const w1 = pubCtx.measureText(label).width;
    const w2 = pubCtx.measureText(area).width;
    pubCtx.fillRect(cx - Math.max(w1, w2) / 2 - 5, cy - 16, Math.max(w1, w2) + 10, 34);
    pubCtx.fillStyle = '#000';
    pubCtx.fillText(label, cx, cy - 7);
    pubCtx.font = '11px sans-serif';
    pubCtx.fillStyle = '#444';
    pubCtx.fillText(area, cx, cy + 9);
  }
  pubCtx.strokeStyle = '#111';
  pubCtx.lineWidth = 3.5;
  pubCtx.strokeRect(...t.toPx(0, s.height), s.width * t.scale, s.height * t.scale);

  document.getElementById('pubMeta').innerHTML =
    `<b>${escapeHtml(s.name)}</b> v${currentPub.version}<br>` +
    `${s.width} × ${s.height} mm · 发布于 ${currentPub.publishedAt}`;

  // 明细
  const ul = document.getElementById('pubPieceList');
  for (const pc of s.pieces) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="swatch" style="background:${pc.color}"></span>
      <span class="piece-meta"><span class="no">#${pc.pieceNo}</span>
      <span class="area">${pc.area} mm²</span></span>`;
    ul.appendChild(li);
  }

  // 清单
  const L = s.leadList;
  let html = '<table><thead><tr><th>#</th><th>起点→终点</th><th class="num">长度</th></tr></thead><tbody>';
  L.internal.forEach((r) => {
    const a = r.points[0], b = r.points[r.points.length - 1];
    html += `<tr><td>${r.no}</td><td>(${a[0]},${a[1]})→(${b[0]},${b[1]})</td><td class="num">${fmt(r.length)}</td></tr>`;
  });
  html += `<tr class="totals"><td colspan="2">内部公共边（${L.internalCount} 根）</td><td class="num">${fmt(L.internalTotal)}</td></tr>`;
  L.frameBars.forEach((b) => {
    html += `<tr><td>${b.name}</td><td></td><td class="num">${fmt(b.length)}</td></tr>`;
  });
  html += `<tr class="totals"><td colspan="2">外框</td><td class="num">${fmt(L.frameTotal)}</td></tr>`;
  html += `<tr class="totals"><td colspan="2">铅条总长</td><td class="num">${fmt(L.grandTotal)}</td></tr>`;
  html += '</tbody></table>';
  document.getElementById('pubLeadList').innerHTML = html;
}

// ================= 事件绑定与启动 =================

document.getElementById('tabDraft').addEventListener('click', () => switchTab('draft'));
document.getElementById('tabPublished').addEventListener('click', () => switchTab('published'));
document.getElementById('tabProduction').addEventListener('click', () => switchTab('production'));
document.getElementById('btnCreate').addEventListener('click', createDesign);
document.getElementById('designSelect').addEventListener('change', (e) => loadDraft(Number(e.target.value)));
document.getElementById('pubDesignSelect').addEventListener('change', loadPubVersions);
document.getElementById('pubVersionSelect').addEventListener('change', (e) => loadPubVersion(e.target.value));
document.getElementById('btnStart').addEventListener('click', () => {
  if (state.editingId) cancelDrawing();
  if (!state.drawing) startDrawing();
});
document.getElementById('btnFinish').addEventListener('click', () => {
  if (!state.drawing) {
    showError({ error: '请先点击“开始绘制新片”，或直接在文本框输入坐标' });
    return;
  }
  const parsed = coordsFromTextarea();
  if (parsed.error) { showError({ error: parsed.error }); return; }
  if (parsed.points.length) state.drawing.points = parsed.points;
  finishDrawing();
});
document.getElementById('btnUndo').addEventListener('click', () => {
  if (state.drawing?.points.length) {
    state.drawing.points.pop();
    syncCoordsText();
    renderDraft();
  }
});
document.getElementById('btnCancel').addEventListener('click', cancelDrawing);
document.getElementById('btnPublish').addEventListener('click', publishDraft);

function switchTab(which) {
  document.getElementById('tabDraft').classList.toggle('active', which === 'draft');
  document.getElementById('tabPublished').classList.toggle('active', which === 'published');
  document.getElementById('tabDiff').classList.toggle('active', which === 'diff');
  document.getElementById('tabProduction').classList.toggle('active', which === 'production');
  document.getElementById('viewDraft').hidden = which !== 'draft';
  document.getElementById('viewPublished').hidden = which !== 'published';
  document.getElementById('viewDiff').hidden = which !== 'diff';
  document.getElementById('viewProduction').hidden = which !== 'production';
  if (which === 'published') loadPubVersions();
  if (which === 'diff') enterDiff();
  if (which === 'production') enterProduction();
}

(async function init() {
  const designs = await refreshDesignSelect('designSelect', 'pubDesignSelect');
  if (designs.length) {
    document.getElementById('designSelect').value = designs[0].id;
    await loadDraft(designs[0].id);
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#888';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('请在左侧“新建图纸”，输入正整数毫米的窗框宽高', canvas.width / 2, canvas.height / 2);
  }
})();

// ================= 版本核对 =================

const diffState = { result: null };

const diffCanvas = document.getElementById('diffCanvas');
const diffCtx = diffCanvas.getContext('2d');

const DIFF_STYLE = {
  kept: { color: '#1565c0', text: '沿用' },
  removed: { color: '#d32f2f', text: '取消' },
  added: { color: '#2e7d4f', text: '新增' },
};

async function enterDiff() {
  await refreshDesignSelect('diffDesignSelect');
  await loadDiffVersions();
}

async function loadDiffVersions() {
  const id = document.getElementById('diffDesignSelect').value;
  const fromSel = document.getElementById('diffFromSelect');
  const toSel = document.getElementById('diffToSelect');
  fromSel.innerHTML = '';
  toSel.innerHTML = '';
  if (!id) return;
  const data = await api('GET', `/api/designs/${id}/publications`);
  const pubs = data.publications; // 版本倒序
  if (!pubs.length) {
    fromSel.innerHTML = '<option value="">（暂无发布版）</option>';
    toSel.innerHTML = '<option value="">（暂无发布版）</option>';
    return;
  }
  const asc = pubs.slice().reverse();
  for (const p of asc) {
    for (const sel of [fromSel, toSel]) {
      const opt = document.createElement('option');
      opt.value = p.version;
      opt.textContent = `v${p.version} · ${p.publishedAt}`;
      sel.appendChild(opt);
    }
  }
  fromSel.value = asc[asc.length - 2] ? asc[asc.length - 2].version : asc[0].version;
  toSel.value = asc[asc.length - 1].version;
}

async function runDiff() {
  const designId = document.getElementById('diffDesignSelect').value;
  const fromVersion = Number(document.getElementById('diffFromSelect').value);
  const toVersion = Number(document.getElementById('diffToSelect').value);
  const msg = document.getElementById('diffMsg');
  if (!designId || !fromVersion || !toVersion) {
    msg.textContent = '请选择同一图纸的两个已发布版本。';
    return;
  }
  if (fromVersion === toVersion) {
    msg.textContent = '请选择两个不同的版本（同版本可比较，但所有线段都会归为“沿用”）。';
  } else {
    msg.textContent = '';
  }
  try {
    const url = `/api/designs/${designId}/publications/diff?fromVersion=${fromVersion}&toVersion=${toVersion}`;
    const data = await api('GET', url);
    diffState.result = data;
    renderDiff();
    showDiffBanner(false);
  } catch (err) {
    diffState.result = null;
    renderDiffEmpty();
    showDiffBanner('error', err.message);
  }
}

function showDiffBanner(kind, text) {
  const b = document.getElementById('diffBanner');
  if (!kind) { b.hidden = true; b.textContent = ''; return; }
  b.className = `banner ${kind === 'error' ? 'error' : 'success'}`;
  b.hidden = false;
  b.textContent = text;
}

function renderDiffEmpty() {
  diffCtx.clearRect(0, 0, diffCanvas.width, diffCanvas.height);
  document.getElementById('diffSummary').innerHTML = '';
  document.getElementById('diffInternal').innerHTML = '';
  document.getElementById('diffFrame').innerHTML = '';
}

function renderDiff() {
  const { meta, diff } = diffState.result;

  // ---- 合计卡 ----
  document.getElementById('diffSummary').innerHTML = `
    <div class="muted" style="margin:0 0 6px">
      <b>${escapeHtml(meta.designName || `图纸 #${meta.designId}`)}</b><br>
      v${meta.earlier.version}（${meta.earlier.publishedAt}） →
      v${meta.later.version}（${meta.later.publishedAt}）<br>
      窗框 ${meta.width} × ${meta.height} mm
    </div>
    ${summaryTable(diff.internal.totals, diff.internal.counts, '内部公共边')}
    ${summaryTable(diff.frameTotals, diff.frameCounts, '四根外框')}
    ${summaryTable(diff.totals, diff.counts, '铅条总长')}
    <div class="hint">合计均先对各段原始长度求和，再四舍五入到 0.01 mm。</div>`;

  // ---- 内部明细 ----
  const intEl = document.getElementById('diffInternal');
  const ic = diff.internal;
  if (!ic.kept.length && !ic.removed.length && !ic.added.length) {
    intEl.innerHTML = '<div class="hint">两版都没有内部公共边。</div>';
  } else {
    let html = '<table><thead><tr><th>类别</th><th>起点 → 终点 (mm)</th><th class="num">长度</th></tr></thead><tbody>';
    html += rowsOf(ic.removed, 'removed');
    html += rowsOf(ic.added, 'added');
    html += rowsOf(ic.kept, 'kept');
    html += `<tr class="totals"><td colspan="2">内部公共边合计</td><td class="num">
      沿用 ${fmt(ic.totals.kept)} / 取消 ${fmt(ic.totals.removed)} / 新增 ${fmt(ic.totals.added)}</td></tr>`;
    html += '</tbody></table>';
    intEl.innerHTML = html;
  }

  // ---- 外框明细 ----
  const frEl = document.getElementById('diffFrame');
  let frHtml = '<table><thead><tr><th>外框</th><th>沿用</th><th>取消</th><th>新增</th></tr></thead><tbody>';
  for (const side of diff.frameOrder) {
    const f = diff.frame[side];
    frHtml += `<tr><td>${side}</td>
      <td class="num kept">${f.counts.kept ? `${fmt(f.totals.kept)}（${f.counts.kept}）` : '—'}</td>
      <td class="num removed">${f.counts.removed ? `${fmt(f.totals.removed)}（${f.counts.removed}）` : '—'}</td>
      <td class="num added">${f.counts.added ? `${fmt(f.totals.added)}（${f.counts.added}）` : '—'}</td></tr>`;
  }
  frHtml += `<tr class="totals"><td>外框合计</td>
    <td class="num kept">${fmt(diff.frameTotals.kept)}</td>
    <td class="num removed">${fmt(diff.frameTotals.removed)}</td>
    <td class="num added">${fmt(diff.frameTotals.added)}</td></tr>`;
  frHtml += '</tbody></table>';
  frEl.innerHTML = frHtml;

  document.getElementById('diffCanvasHint').textContent =
    `共沿用 ${diff.counts.kept} 段、取消 ${diff.counts.removed} 段、新增 ${diff.counts.added} 段；部分重叠处已按端点拆分。`;

  renderDiffCanvas();
}

function summaryTable(totals, counts, title) {
  return `<table class="diff-sum"><thead><tr><th>${title}</th><th class="num">沿用</th><th class="num">取消</th><th class="num">新增</th></tr></thead>
    <tbody><tr>
      <td class="muted">${counts.kept} / ${counts.removed} / ${counts.added} 段</td>
      <td class="num kept">${fmt(totals.kept)}</td>
      <td class="num removed">${fmt(totals.removed)}</td>
      <td class="num added">${fmt(totals.added)}</td>
    </tr></tbody></table>`;
}

function rowsOf(list, kind) {
  return list.map((s) => `<tr>
    <td><span class="diff-tag ${kind}">${DIFF_STYLE[kind].text}</span></td>
    <td>(${s.from[0]},${s.from[1]}) → (${s.to[0]},${s.to[1]})</td>
    <td class="num">${fmt(s.length)}</td></tr>`).join('');
}

function renderDiffCanvas() {
  const { diff } = diffState.result;
  const frame = { width: diff.width, height: diff.height };
  const t = getTransform(frame, diffCanvas);
  diffCtx.clearRect(0, 0, diffCanvas.width, diffCanvas.height);

  // 背景
  diffCtx.fillStyle = '#fbfaf7';
  diffCtx.fillRect(...t.toPx(0, frame.height), frame.width * t.scale, frame.height * t.scale);

  // 先画取消/新增（偏离中线向两侧微移，避免与沿用重叠时互相盖住）
  drawDiffSegments(diff.internal.removed, 'removed', t, -2.5);
  for (const side of diff.frameOrder) drawDiffSegments(diff.frame[side].removed, 'removed', t, -2.5);
  drawDiffSegments(diff.internal.added, 'added', t, 2.5);
  for (const side of diff.frameOrder) drawDiffSegments(diff.frame[side].added, 'added', t, 2.5);
  // 沿用最后画在中线上
  drawDiffSegments(diff.internal.kept, 'kept', t, 0);
  for (const side of diff.frameOrder) drawDiffSegments(diff.frame[side].kept, 'kept', t, 0);

  // 窗框
  diffCtx.strokeStyle = '#222';
  diffCtx.lineWidth = 2;
  diffCtx.strokeRect(...t.toPx(0, frame.height), frame.width * t.scale, frame.height * t.scale);
}

function drawDiffSegments(list, kind, t, offsetPx) {
  if (!list.length) return;
  diffCtx.lineCap = 'round';
  for (const s of list) {
    let [x1, y1] = t.toPx(s.from[0], s.from[1]);
    let [x2, y2] = t.toPx(s.to[0], s.to[1]);
    if (offsetPx) {
      const nx = -(y2 - y1);
      const ny = x2 - x1;
      const nl = Math.hypot(nx, ny) || 1;
      x1 += nx / nl * offsetPx; x2 += nx / nl * offsetPx;
      y1 += ny / nl * offsetPx; y2 += ny / nl * offsetPx;
    }
    diffCtx.beginPath();
    diffCtx.moveTo(x1, y1);
    diffCtx.lineTo(x2, y2);
    diffCtx.strokeStyle = DIFF_STYLE[kind].color;
    diffCtx.globalAlpha = kind === 'kept' ? 0.9 : 0.75;
    diffCtx.lineWidth = kind === 'kept' ? 4 : 6;
    if (kind === 'removed') diffCtx.setLineDash([7, 5]); else diffCtx.setLineDash([]);
    diffCtx.stroke();
    diffCtx.setLineDash([]);
    diffCtx.globalAlpha = 1;
    // 端点
    for (const [x, y] of [[x1, y1], [x2, y2]]) {
      if (kind !== 'kept' || offsetPx === 0) {
        diffCtx.beginPath();
        diffCtx.arc(x, y, 2.5, 0, Math.PI * 2);
        diffCtx.fillStyle = DIFF_STYLE[kind].color;
        diffCtx.fill();
      }
    }
  }
}

document.getElementById('tabDiff').addEventListener('click', () => switchTab('diff'));
document.getElementById('diffDesignSelect').addEventListener('change', loadDiffVersions);
document.getElementById('btnDiffRun').addEventListener('click', runDiff);

// ================= 铅条生产 =================

const prod = {
  materials: [],
  designs: [],
  publications: [],   // 选中图纸的发布版
  plans: [],
  detailPlan: null,   // 当前展示详情的计划
};

function prodBanner(kind, msg) {
  const b = document.getElementById('prodBanner');
  if (!kind) { b.hidden = true; b.textContent = ''; return; }
  b.className = `banner ${kind === 'error' ? 'error' : 'success'}`;
  b.hidden = false;
  b.innerHTML = msg;
  clearTimeout(prodBanner._t);
  if (kind === 'success') prodBanner._t = setTimeout(() => { b.hidden = true; }, 3000);
}

async function enterProduction() {
  prodBanner(false);
  await Promise.all([loadMaterials(), refreshProdDesigns(), loadPlans()]);
}

// ---------- 库存 ----------

async function loadMaterials() {
  const data = await api('GET', '/api/materials');
  prod.materials = data.materials;
  renderMaterials();
  renderMaterialOptions();
}

function renderMaterials() {
  const el = document.getElementById('matList');
  if (!prod.materials.length) {
    el.innerHTML = '<div class="hint">尚未登记原材。</div>';
    return;
  }
  let html = '<table><thead><tr><th>规格</th><th class="num">定尺</th><th class="num">库存</th><th class="num">已预留</th><th class="num">可用</th><th></th></tr></thead><tbody>';
  for (const m of prod.materials) {
    html += `<tr>
      <td>${escapeHtml(m.name)}</td>
      <td class="num">${fmt(m.length)}</td>
      <td class="num">${m.stock}</td>
      <td class="num">${m.reserved}</td>
      <td class="num"><b>${m.available}</b></td>
      <td><input type="number" min="0" step="1" value="${m.stock}" class="stock-edit" data-id="${m.id}" style="width:72px"></td>
    </tr>`;
  }
  html += '</tbody></table>';
  el.innerHTML = html;
  el.querySelectorAll('.stock-edit').forEach((inp) => {
    inp.addEventListener('change', () => updateStock(Number(inp.dataset.id), Number(inp.value), inp));
  });
}

function renderMaterialOptions() {
  const sel = document.getElementById('planMaterialSelect');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const m of prod.materials) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${m.name}（定尺 ${fmt(m.length)} mm · 可用 ${m.available} 根）`;
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function addMaterial() {
  const msg = document.getElementById('matMsg');
  const name = document.getElementById('matName').value;
  const length = Number(document.getElementById('matLength').value);
  const stock = Number(document.getElementById('matStock').value);
  if (!name.trim()) { msg.textContent = '请填写规格名称'; return; }
  try {
    await api('POST', '/api/materials', { name, length, stock });
    document.getElementById('matName').value = '';
    msg.textContent = '✓ 已登记';
    await loadMaterials();
  } catch (err) { msg.textContent = '⛔ ' + err.message; }
}

async function updateStock(id, stock, inp) {
  const msg = document.getElementById('matMsg');
  if (!Number.isInteger(stock) || stock < 0) {
    msg.textContent = '⛔ 库存根数必须是非负整数，输入已忽略';
    await loadMaterials();
    return;
  }
  try {
    await api('PATCH', `/api/materials/${id}`, { stock });
    msg.textContent = '✓ 库存已更新';
    await loadMaterials();
    await loadPlans();
  } catch (err) {
    msg.textContent = '⛔ ' + err.message;
    await loadMaterials();
  }
}

// ---------- 图纸/版本/规格选择 ----------

async function refreshProdDesigns() {
  const data = await api('GET', '/api/designs');
  prod.designs = data.designs;
  const sel = document.getElementById('planDesignSelect');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const d of prod.designs) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.latest_version
      ? `${d.name}（最新 v${d.latest_version}）`
      : `${d.name}（暂无发布版）`;
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  await loadPlanVersions();
}

async function loadPlanVersions() {
  const sel = document.getElementById('planVersionSelect');
  sel.innerHTML = '';
  prod.publications = [];
  const id = Number(document.getElementById('planDesignSelect').value);
  if (!id) {
    sel.innerHTML = '<option value="">（请先选择图纸）</option>';
    return;
  }
  const data = await api('GET', `/api/designs/${id}/publications`);
  prod.publications = data.publications;
  if (!data.publications.length) {
    sel.innerHTML = '<option value="">（该图纸暂无发布版）</option>';
    return;
  }
  for (const p of data.publications) {
    const opt = document.createElement('option');
    // 列表接口只有 id/version/publishedAt；需要 publication 的完整 id
    opt.value = p.id;
    opt.textContent = `v${p.version} · ${p.publishedAt}`;
    sel.appendChild(opt);
  }
}

function selectedPlanInput() {
  return {
    publicationId: Number(document.getElementById('planVersionSelect').value),
    materialId: Number(document.getElementById('planMaterialSelect').value),
    copies: Number(document.getElementById('planCopies').value),
    kerf: Number(document.getElementById('planKerf').value),
  };
}

// ---------- 预览 ----------

async function previewPlan() {
  const body = selectedPlanInput();
  if (!body.publicationId) { showPreviewHint('请先发布图纸，再选择发布版本。'); return; }
  if (!body.materialId) { showPreviewHint('请先登记原材规格。'); return; }
  try {
    const data = await api('POST', '/api/plans/preview', body);
    prod.detailPlan = null;
    renderLayout(data.preview, { preview: true });
    prodBanner(false);
  } catch (err) {
    const d = err.data || {};
    let txt = '⛔ ' + (d.error || err.message);
    if (d.segment) txt += `（${d.segment.name}：成品 ${fmt(d.segment.length)} mm，含刀损 ${fmt(d.segment.withKerf)} mm，超过原材定尺）`;
    prodBanner('error', txt);
    showPreviewHint(txt.replace('⛔ ', ''));
  }
}

function showPreviewHint(text) {
  document.getElementById('previewContent').innerHTML =
    `<div class="hint">${escapeHtml(text)}</div>`;
}

// detail: { preview:true } 或 { plan:obj }
function renderLayout(detail, mode) {
  const p = mode.preview ? detail : detail.plan;
  const L = p.layout;
  const isPreview = !!mode.preview;
  let html = '';

  html += `<div class="plan-head">
    <div><b>${isPreview ? '排产预览（不落库、不占库存）' : `计划 #${p.id} · ${escapeHtml(p.name)}`}</b></div>
    <div class="muted">发布版 v${p.version} · ${p.copies} 件 ·
      原材 ${escapeHtml(p.material ? p.material.name : '')}（定尺 ${fmt(L.materialLength)} mm）·
      每刀损耗 ${fmt(L.kerf)} mm</div></div>`;

  // 库存结论
  if (isPreview || p.status === 'draft') {
    const need = L.requiredBars, avail = p.availableBars ?? detail.availableBars;
    const shortage = p.shortage ?? detail.shortage ?? Math.max(0, need - avail);
    if (shortage > 0) {
      html += `<div class="stock-badge bad">⚠ 需用 <b>${need}</b> 根，可用 <b>${avail}</b> 根，缺口 <b>${shortage}</b> 根——不能确认</div>`;
    } else {
      html += `<div class="stock-badge ok">✓ 需用 <b>${need}</b> 根，可用 <b>${avail}</b> 根，库存充足（预览不占库存）</div>`;
    }
  } else {
    html += `<div class="stock-badge ${p.status === 'confirmed' ? 'ok' : 'cancel'}">
      ${p.status === 'confirmed' ? '✓ 已确认（库存已原子预留）' : '已取消（预留已释放）'}</div>`;
  }

  html += `<div class="muted">共 ${L.totals.segmentCount} 段；成品合计 ${fmt(L.totals.finishedLength)} mm，
    刀损合计 ${fmt(L.totals.kerfTotal)} mm，余料合计 ${fmt(L.totals.remainderTotal)} mm。</div>`;

  html += '<div class="bars">';
  for (const bar of L.bars) {
    html += `<div class="bar-card">
      <div class="bar-title">原材 #${bar.index} · 用 ${fmt(bar.usedLength)} mm · 余料 <b>${fmt(bar.remainder)}</b> mm</div>
      <div class="bar-track">${barTrack(bar, L.materialLength)}</div>
      <table><thead><tr><th>件次</th><th>切段</th><th class="num">成品</th><th class="num">刀损</th></tr></thead><tbody>`;
    for (const c of bar.cuts) {
      html += `<tr><td>第 ${c.piece} 件</td><td>${sourceLabel(c)}</td>
        <td class="num">${fmt(c.length)}</td><td class="num muted">${fmt(c.kerf)}</td></tr>`;
    }
    html += '</tbody></table></div>';
  }
  html += '</div>';

  if (isPreview) {
    html += `<div class="btn-row"><button id="btnSaveDraft" class="primary">存为草稿计划</button></div>`;
  } else if (p.status === 'draft') {
    html += `<div class="btn-row">
      <button id="btnPlanConfirm" class="primary">确认计划（预留 ${L.requiredBars} 根）</button>
      <button id="btnPlanDelete" class="danger">删除草稿</button>
      <button id="btnPlanReedit">按此参数重新编辑</button></div>`;
  } else if (p.status === 'confirmed') {
    html += `<div class="btn-row"><button id="btnPlanCancel" class="danger">取消计划（释放预留）</button></div>`;
  }

  document.getElementById('previewContent').innerHTML = html;

  const saveBtn = document.getElementById('btnSaveDraft');
  if (saveBtn) saveBtn.addEventListener('click', () => saveDraft(detail));
  const cf = document.getElementById('btnPlanConfirm');
  if (cf) cf.addEventListener('click', () => confirmPlan(p.id));
  const de = document.getElementById('btnPlanDelete');
  if (de) de.addEventListener('click', () => deletePlan(p.id));
  const ca = document.getElementById('btnPlanCancel');
  if (ca) ca.addEventListener('click', () => cancelPlan(p.id));
  const re = document.getElementById('btnPlanReedit');
  if (re) re.addEventListener('click', () => fillEditorFromPlan(p));
}

function sourceLabel(c) {
  const tail = c.from && c.to
    ? ` <span class="muted small">(${c.from[0]},${c.from[1]})→(${c.to[0]},${c.to[1]})</span>`
    : '';
  return `${c.name}${tail}`;
}

// 简单的余料比例条
function barTrack(bar, totalLen) {
  let pct = 0, acc = 0;
  const colors = ['#4C9AFF', '#FFAB00', '#36B37E', '#FF5630', '#6554C0', '#00B8D9'];
  let html = '<div class="track">';
  bar.cuts.forEach((c, i) => {
    const w = (c.length + c.kerf) / totalLen * 100;
    html += `<div class="seg" style="left:${acc}%;width:${w}%;background:${colors[i % colors.length]}"
      title="第${c.piece}件 ${c.name} ${fmt(c.length)} + ${fmt(c.kerf)}"></div>`;
    acc += w;
  });
  pct = acc;
  html += `<div class="rem" style="left:${pct}%;width:${100 - pct}%"></div></div>`;
  return html;
}

// ---------- 草稿保存 / 确认 / 取消 / 删除 ----------

async function saveDraft(preview) {
  const name = document.getElementById('planName').value;
  try {
    const data = await api('POST', '/api/plans', {
      name: name || undefined,
      publicationId: preview.publicationId,
      materialId: preview.material.id,
      copies: preview.copies,
      kerf: preview.kerf,
    });
    prodBanner('success', `✓ 已存为草稿计划 #${data.plan.id}（尚未占用库存）`);
    await loadPlans(data.plan.id);
  } catch (err) { prodBanner('error', '⛔ ' + err.message); }
}

async function confirmPlan(id) {
  try {
    const data = await api('POST', `/api/plans/${id}/confirm`);
    prodBanner('success', `✓ 计划 #${id} 已确认，预留 ${data.plan.requiredBars} 根`);
    await loadMaterials();
    await loadPlans(id);
  } catch (err) {
    const d = err.data || {};
    prodBanner('error', '⛔ ' + (d.error || err.message));
    await loadMaterials();
    await loadPlans(id);
  }
}

async function cancelPlan(id) {
  if (!confirm(`确定取消计划 #${id}？已预留的根数将释放。`)) return;
  try {
    const data = await api('POST', `/api/plans/${id}/cancel`);
    prodBanner('success', `计划 #${id} 已取消，释放 ${data.plan.requiredBars} 根`);
    await loadMaterials();
    await loadPlans(id);
  } catch (err) { prodBanner('error', '⛔ ' + err.message); await loadPlans(id); }
}

async function deletePlan(id) {
  if (!confirm(`确定删除草稿计划 #${id}？`)) return;
  try {
    await api('DELETE', `/api/plans/${id}`);
    prodBanner('success', `草稿 #${id} 已删除`);
    prod.detailPlan = null;
    showPreviewHint('草稿已删除。');
    await loadPlans();
  } catch (err) { prodBanner('error', '⛔ ' + err.message); }
}

function fillEditorFromPlan(p) {
  document.getElementById('planDesignSelect').value = p.designId;
  document.getElementById('planCopies').value = p.copies;
  document.getElementById('planKerf').value = p.kerf;
  loadPlanVersions().then(() => {
    document.getElementById('planVersionSelect').value = p.publicationId;
    document.getElementById('planMaterialSelect').value = p.materialId;
  });
}

// ---------- 计划列表 ----------

async function loadPlans(selectId) {
  const data = await api('GET', '/api/plans');
  prod.plans = data.plans;
  renderPlanList();
  if (selectId) {
    const p = prod.plans.find((x) => x.id === selectId);
    if (p) renderLayout({ plan: p }, { preview: false });
  }
}

function renderPlanList() {
  const el = document.getElementById('planList');
  if (!prod.plans.length) {
    el.innerHTML = '<div class="hint">暂无计划。</div>';
    return;
  }
  el.innerHTML = prod.plans.map((p) => {
    const badge = p.status === 'confirmed'
      ? '<span class="badge ok">已确认</span>'
      : p.status === 'canceled'
        ? '<span class="badge bad" style="background:#eee;color:#888">已取消</span>'
        : '<span class="badge bad">草稿</span>';
    const warn = p.status === 'draft' && p.shortage > 0
      ? ` <span class="gap-info">缺 ${p.shortage} 根</span>` : '';
    return `<div class="plan-item${prod.detailPlan === p.id ? ' active' : ''}" data-id="${p.id}">
      <div>${badge} <b>#${p.id}</b> ${escapeHtml(p.name)}${warn}</div>
      <div class="muted small">v${p.version} · ${p.copies}件 · 用 ${p.requiredBars} 根 ·
        ${escapeHtml(p.material ? p.material.name : '规格已删')}</div>
    </div>`;
  }).join('');
  el.querySelectorAll('.plan-item').forEach((div) => {
    div.addEventListener('click', () => {
      const p = prod.plans.find((x) => x.id === Number(div.dataset.id));
      prod.detailPlan = p.id;
      renderPlanList();
      renderLayout({ plan: p }, { preview: false });
    });
  });
}

// ---------- 事件绑定 ----------

document.getElementById('btnMatAdd').addEventListener('click', addMaterial);
document.getElementById('planDesignSelect').addEventListener('change', loadPlanVersions);
document.getElementById('btnPlanPreview').addEventListener('click', previewPlan);
