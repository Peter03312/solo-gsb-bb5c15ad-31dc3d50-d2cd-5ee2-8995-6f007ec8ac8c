'use strict';

// 两版发布快照的铅条下料核对（只读）。
// 依据：同一张图纸两个已发布版本快照中的铅条清单（内部公共边 + 四根外框）。
// 规则：
//   - 共线且空间重叠的部分算“沿用”；其余按较早版/较晚版分别记为“取消/新增”；
//   - 反向记录（起点终点颠倒）、清单顺序变化、T 接处分段变化（一侧整边、另一侧数段）
//     都不得产生虚假差异——比较完全基于几何集合，与记录方向、顺序、分段无关；
//   - 部分重叠必须在重叠端点处拆分成沿用/取消/新增三段。
// 坐标取自不可变快照（至多两位小数的毫米值），统一换算为整数“厘”（0.01mm），
// 共线/区间运算全部使用精确整数；合计先按原始长度求和，再四舍五入到 0.01 mm。

const H_PER_MM = 100;

class DiffError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const round2 = (v) => {
  const r = Math.round((v + Number.EPSILON) * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
};

// 快照毫米坐标 → 整数厘。快照由服务端发布时生成（顶点为整数毫米，
// T 接节点经 round2），出现无法精确表示为 0.01mm 的值说明快照已损坏。
function toH(v, label) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new DiffError('invalid_snapshot', `发布快照坐标不合法（${label}）`);
  }
  const h = v * H_PER_MM;
  if (Math.abs(h - Math.round(h)) > 1e-6) {
    throw new DiffError('invalid_snapshot', `发布快照坐标精度超过 0.01 mm（${label}）`);
  }
  return Math.round(h);
}

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

// 解析快照铅条清单 → { internal:[seg], frame:[seg] }
// seg = { a:[X,Y], b:[X,Y] }（整数厘，方向、顺序保持原样但比较时会归一化）
function extractSnapshotSegments(snapshot) {
  const ll = snapshot && snapshot.leadList;
  if (!ll || !Array.isArray(ll.internal) || !Array.isArray(ll.frameBars)) {
    throw new DiffError('invalid_snapshot', '发布快照缺少铅条清单');
  }
  const pt = (p, label) => {
    if (!Array.isArray(p) || p.length !== 2) {
      throw new DiffError('invalid_snapshot', `发布快照端点不合法（${label}）`);
    }
    return [toH(p[0], label), toH(p[1], label)];
  };
  const internal = ll.internal.map((r, i) => {
    const pts = Array.isArray(r.points) ? r.points : [];
    if (pts.length < 2) {
      throw new DiffError('invalid_snapshot', `内部公共边 #${i + 1} 缺少端点`);
    }
    const seg = {
      a: pt(pts[0], `内部公共边 #${i + 1} 起点`),
      b: pt(pts[pts.length - 1], `内部公共边 #${i + 1} 终点`),
    };
    if (seg.a[0] === seg.b[0] && seg.a[1] === seg.b[1]) {
      throw new DiffError('invalid_snapshot', `内部公共边 #${i + 1} 长度为 0`);
    }
    return seg;
  });
  if (ll.frameBars.length !== 4) {
    throw new DiffError('invalid_snapshot', '发布快照外框应为四根');
  }
  const frame = ll.frameBars.map((bar, i) => {
    const label = `外框${bar.name ? `“${bar.name}”` : `#${i + 1}`}`;
    const seg = { a: pt(bar.from, `${label} 起点`), b: pt(bar.to, `${label} 终点`) };
    if (seg.a[0] === seg.b[0] && seg.a[1] === seg.b[1]) {
      throw new DiffError('invalid_snapshot', `${label} 长度为 0`);
    }
    return seg;
  });
  return { internal, frame };
}

// ---------- 直线归一化 ----------

// 由线段得到归一化无向直线：
//   直线方程 A x + B y + C = 0（系数取 gcd 并规定 (A,B) 半平面朝向）作为共线分组键；
//   原始整数格点单位方向 (ux,uy) 与该直线绑定，用于 1:1 的整数参数 k；
//   显示方向 (dirx,diry) 归一半圆（朝上，水平时朝右），保证反向记录几何一致。
function lineOf(seg) {
  const [ax, ay] = seg.a;
  const dx = seg.b[0] - ax, dy = seg.b[1] - ay;
  let A = dy, B = -dx, C = -(A * ax + B * ay);
  const g0 = gcd(gcd(Math.abs(A), Math.abs(B)), Math.abs(C)) || 1;
  A /= g0; B /= g0; C /= g0;
  if (A < 0 || (A === 0 && B < 0)) { A = -A; B = -B; C = -C; }
  const gw = gcd(Math.abs(dx), Math.abs(dy)) || 1;
  const ux = dx / gw, uy = dy / gw;
  let dirx = ux, diry = uy;
  if (diry < 0 || (diry === 0 && dirx < 0)) { dirx = -dirx; diry = -diry; }
  return { key: `${A},${B},${C}`, A, B, C, ux, uy, dirx, diry };
}

// ---------- 一组共线线段的区间差集 ----------

// 同一直线的若干段 → 沿格点参数 k 的区间并集。
// 仅端点相接（lo === last.hi）不合并，保留 T 接处分段的可辨性；真重叠才合并。
// k 为沿最简整数方向 u 的“整数倍”：p = anchor + k·u（u 为原始格点方向，
// 故不能直接用点积——点积还多乘了 |u|²，必须除以 |u|²）。
function unionIntervals(segs, anchor, ux, uy) {
  const u2 = ux * ux + uy * uy;
  const k = (p) => {
    const dot = (p[0] - anchor[0]) * ux + (p[1] - anchor[1]) * uy;
    if (dot % u2 !== 0) {
      throw new DiffError('invalid_snapshot', '共线端点无法用整数格点参数表示');
    }
    return dot / u2;
  };
  const iv = segs.map((s) => {
    let k1 = k(s.a), k2 = k(s.b);
    if (k1 > k2) [k1, k2] = [k2, k1];
    return [k1, k2];
  });
  iv.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const out = [];
  for (const [lo, hi] of iv) {
    const last = out[out.length - 1];
    if (last && lo < last[1]) {
      if (hi > last[1]) last[1] = hi;
    } else {
      out.push([lo, hi]);
    }
  }
  return out;
}

const inUnion = (intervals, k) => intervals.some(([lo, hi]) => k >= lo && k <= hi);

// 较早/较晚两批共线段 → kept/removed/added 片段（相邻同类自动合并）。
// 片段的 from/to 按显示方向归一；rawLength 为未舍入的毫米长度。
function diffOnLine(line, earlierSegs, laterSegs) {
  const { ux, uy, dirx, diry } = line;
  const allPts = earlierSegs.concat(laterSegs).flatMap((s) => [s.a, s.b]);
  const anchor = allPts.reduce((m, p) =>
    (p[1] < m[1] || (p[1] === m[1] && p[0] < m[0]) ? p : m));

  const A = unionIntervals(earlierSegs, anchor, ux, uy);
  const B = unionIntervals(laterSegs, anchor, ux, uy);

  const sign = dirx === ux && diry === uy ? 1 : -1;
  const pointAt = (kk) => [anchor[0] + kk * ux, anchor[1] + kk * uy];
  const stepLen = Math.hypot(ux, uy) / H_PER_MM; // 一格点参数对应的毫米长度

  // 扫掠：取全部端点为分界，逐开区间判定归属（点接触区间为空，不产生差异）
  const cuts = [...new Set(A.flat().concat(B.flat()))].sort((p, q) => p - q);
  const parts = { kept: [], removed: [], added: [] };
  const pushMerged = (kind, lo, hi) => {
    const arr = parts[kind];
    const last = arr[arr.length - 1];
    if (last && last.hi === lo) last.hi = hi;
    else arr.push({ lo, hi });
  };
  for (let i = 0; i + 1 < cuts.length; i++) {
    const u = cuts[i], v = cuts[i + 1];
    if (u === v) continue;
    const mid = u + (v - u) / 2;
    const inA = inUnion(A, mid);
    const inB = inUnion(B, mid);
    if (inA && inB) pushMerged('kept', u, v);
    else if (inA) pushMerged('removed', u, v);
    else if (inB) pushMerged('added', u, v);
  }

  const fragments = { kept: [], removed: [], added: [] };
  for (const kind of ['kept', 'removed', 'added']) {
    for (const part of parts[kind]) {
      const p1 = pointAt(part.lo);
      const p2 = pointAt(part.hi);
      const ordered = sign > 0 ? [p1, p2] : [p2, p1];
      const rawLength = (part.hi - part.lo) * stepLen;
      fragments[kind].push({
        from: [ordered[0][0] / H_PER_MM, ordered[0][1] / H_PER_MM],
        to: [ordered[1][0] / H_PER_MM, ordered[1][1] / H_PER_MM],
        length: round2(rawLength),
        rawLength,
      });
    }
  }
  return fragments;
}

const sumRaw = (frags) => frags.reduce((s, f) => s + f.rawLength, 0);
const stripRaw = (frags) => frags.map(({ rawLength, ...rest }) => rest);
const minPoint = (groups) => {
  let mx = Infinity, my = Infinity;
  for (const fs of groups) {
    for (const f of fs) {
      for (const p of [f.from, f.to]) {
        if (p[1] < my || (p[1] === my && p[0] < mx)) { my = p[1]; mx = p[0]; }
      }
    }
  }
  return [mx, my];
};

// 对一批段（内部公共边 或 某一侧外框）整组比较。
// 返回内部结构（含 rawLength，仅供进一步合计；序列化前需 serializeSection）。
function diffSection(earlierSegs, laterSegs) {
  const groupsByLine = new Map();
  const bucket = (segs, side) => {
    for (const seg of segs) {
      const line = lineOf(seg);
      let g = groupsByLine.get(line.key);
      if (!g) {
        g = { line, earlier: [], later: [] };
        groupsByLine.set(line.key, g);
      }
      g[side].push(seg);
    }
  };
  bucket(earlierSegs, 'earlier');
  bucket(laterSegs, 'later');

  const groups = [...groupsByLine.values()].map((g) => {
    const raw = diffOnLine(g.line, g.earlier, g.later);
    return {
      raw,
      anchor: minPoint([raw.kept, raw.removed, raw.added]),
      counts: {
        kept: raw.kept.length,
        removed: raw.removed.length,
        added: raw.added.length,
      },
      rawTotals: { kept: sumRaw(raw.kept), removed: sumRaw(raw.removed), added: sumRaw(raw.added) },
    };
  });

  // 分组排序：直线最下端点（先 y 后 x）升序
  groups.sort((g1, g2) => {
    const [x1, y1] = g1.anchor;
    const [x2, y2] = g2.anchor;
    return y1 - y2 || x1 - x2;
  });

  const rawTotals = { kept: 0, removed: 0, added: 0 };
  const counts = { kept: 0, removed: 0, added: 0 };
  for (const g of groups) {
    for (const k of ['kept', 'removed', 'added']) {
      rawTotals[k] += g.rawTotals[k];
      counts[k] += g.counts[k];
    }
  }
  return { groups, counts, rawTotals };
}

function serializeSection(sec, extra = {}) {
  return {
    groups: sec.groups.map((g, i) => ({
      id: i + 1,
      fragments: {
        kept: stripRaw(g.raw.kept),
        removed: stripRaw(g.raw.removed),
        added: stripRaw(g.raw.added),
      },
      counts: g.counts,
      totals: { kept: round2(g.rawTotals.kept), removed: round2(g.rawTotals.removed), added: round2(g.rawTotals.added) },
    })),
    counts: sec.counts,
    totals: {
      kept: round2(sec.rawTotals.kept),
      removed: round2(sec.rawTotals.removed),
      added: round2(sec.rawTotals.added),
    },
    ...extra,
  };
}

// ---------- 外框按侧分组 ----------

function frameSideName(seg, W, H) {
  const [a, b] = [seg.a, seg.b];
  const on = (x, y) => (a[0] === x && a[1] === y) || (b[0] === x && b[1] === y);
  if (a[1] === b[1] && a[1] === 0 && on(0, 0) && on(W, 0)) return '上框';
  if (a[1] === b[1] && a[1] === H && on(0, H) && on(W, H)) return '下框';
  if (a[0] === b[0] && a[0] === 0 && on(0, 0) && on(0, H)) return '左框';
  if (a[0] === b[0] && a[0] === W && on(W, 0) && on(W, H)) return '右框';
  return null;
}

function compareFrame(earlierSegs, laterSegs, W, H) {
  const sideDefs = [
    { name: '上框', from: [0, 0], to: [W / H_PER_MM, 0] },
    { name: '下框', from: [0, H / H_PER_MM], to: [W / H_PER_MM, H / H_PER_MM] },
    { name: '左框', from: [0, 0], to: [0, H / H_PER_MM] },
    { name: '右框', from: [W / H_PER_MM, 0], to: [W / H_PER_MM, H / H_PER_MM] },
  ];
  const classify = (segs, label) => {
    const m = new Map();
    segs.forEach((seg, i) => {
      const name = frameSideName(seg, W, H);
      if (!name) throw new DiffError('invalid_snapshot', `${label}的外框线段位置与窗框不符（第 ${i + 1} 根）`);
      if (m.has(name)) throw new DiffError('invalid_snapshot', `${label}的外框“${name}”重复`);
      m.set(name, seg);
    });
    return m;
  };
  const eMap = classify(earlierSegs, '较早版本');
  const lMap = classify(laterSegs, '较晚版本');

  const sides = [];
  const rawTotals = { kept: 0, removed: 0, added: 0 };
  const counts = { kept: 0, removed: 0, added: 0 };
  for (const def of sideDefs) {
    const e = eMap.get(def.name);
    const l = lMap.get(def.name);
    if (!e || !l) throw new DiffError('invalid_snapshot', `外框“${def.name}”缺失`);
    const sec = diffSection([e], [l]); // 每侧恰一条几何直线
    const g = sec.groups[0];
    sides.push({
      name: def.name,
      from: def.from,
      to: def.to,
      fragments: {
        kept: stripRaw(g.raw.kept),
        removed: stripRaw(g.raw.removed),
        added: stripRaw(g.raw.added),
      },
      counts: g.counts,
      totals: { kept: round2(g.rawTotals.kept), removed: round2(g.rawTotals.removed), added: round2(g.rawTotals.added) },
    });
    for (const k of ['kept', 'removed', 'added']) {
      rawTotals[k] += sec.rawTotals[k];
      counts[k] += sec.counts[k];
    }
  }
  return {
    sides,
    counts,
    rawTotals,
    totals: { kept: round2(rawTotals.kept), removed: round2(rawTotals.removed), added: round2(rawTotals.added) },
  };
}

// ---------- 主入口 ----------

// a/b: { id, version, publishedAt, snapshot }。
// 按版本号自动区分较早版/较晚版（版本号相同则按入参顺序，允许同版本自查）。
function compareSnapshots(a, b) {
  const [earlier, later] = a.version <= b.version ? [a, b] : [b, a];
  const sE = earlier.snapshot;
  const sL = later.snapshot;
  if (!sE || !sL) throw new DiffError('invalid_snapshot', '发布快照不完整');
  if (sE.width !== sL.width || sE.height !== sL.height) {
    throw new DiffError('frame_mismatch', '两个发布版本的窗框尺寸不一致，无法核对');
  }
  const segE = extractSnapshotSegments(sE);
  const segL = extractSnapshotSegments(sL);

  const internalSec = diffSection(segE.internal, segL.internal);
  const internal = serializeSection(internalSec, {
    versionTotals: { earlier: numOr(sE.leadList.internalTotal), later: numOr(sL.leadList.internalTotal) },
  });
  const frameSec = compareFrame(segE.frame, segL.frame, sL.width * H_PER_MM, sL.height * H_PER_MM);
  const { rawTotals: frameRawTotals, ...frame } = frameSec;
  frame.versionTotals = { earlier: numOr(sE.leadList.frameTotal), later: numOr(sL.leadList.frameTotal) };

  return {
    design: { name: sL.name, width: sL.width, height: sL.height },
    earlier: pubBrief(earlier),
    later: pubBrief(later),
    internal,
    frame,
    totals: {
      kept: round2(internalSec.rawTotals.kept + frameRawTotals.kept),
      removed: round2(internalSec.rawTotals.removed + frameRawTotals.removed),
      added: round2(internalSec.rawTotals.added + frameRawTotals.added),
    },
  };
}

function numOr(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function pubBrief(pub) {
  return { publicationId: pub.id, version: pub.version, publishedAt: pub.publishedAt };
}

module.exports = {
  DiffError,
  round2,
  extractSnapshotSegments,
  lineOf,
  diffSection,
  serializeSection,
  compareSegments: (e, l) => serializeSection(diffSection(e, l)),
  compareFrame,
  compareSnapshots,
};
