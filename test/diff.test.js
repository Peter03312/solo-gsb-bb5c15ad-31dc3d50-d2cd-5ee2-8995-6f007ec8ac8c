'use strict';

const { test } = require('node:test');
const assert = require('assert');
const D = require('../src/diff');

// 手工构造发布快照（leadList 只放核对关心的字段）
function snapshot(internalRuns, { width = 100, height = 100 } = {}) {
  const frame = (from, to) => ({ from, to, length: from[0] === to[0] ? height : width });
  return {
    name: '测试窗',
    width,
    height,
    pieces: [],
    leadList: {
      internal: internalRuns.map((pts, i) => ({
        no: i + 1,
        points: pts,
        length: Math.round(100 * Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1])) / 100,
      })),
      internalCount: internalRuns.length,
      internalTotal: internalRuns.reduce((s, pts) => s + Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]), 0) + 0,
      frameBars: [
        { name: '上框', ...{ from: [0, 0], to: [width, 0], length: width } },
        { name: '下框', from: [0, height], to: [width, height], length: width },
        { name: '左框', from: [0, 0], to: [0, height], length: height },
        { name: '右框', from: [width, 0], to: [width, height], length: height },
      ],
      frameTotal: 2 * (width + height),
      grandTotal: 0,
    },
  };
}

const pub = (id, version, snap) => ({ id, version, publishedAt: `t${version}`, snapshot: snap });

function flatten(result, section = 'internal') {
  const out = { kept: [], removed: [], added: [] };
  const groups = result[section].groups || result[section].sides;
  for (const g of groups) {
    for (const kind of Object.keys(out)) {
      for (const f of g.fragments[kind]) out[kind].push(f);
    }
  }
  return out;
}

test('完全相同：全部沿用，无取消/新增（含外框）', () => {
  const s = snapshot([[[50, 0], [50, 100]]]);
  const r = D.compareSnapshots(pub(1, 1, s), pub(2, 2, s));
  assert.deepStrictEqual(r.internal.counts, { kept: 1, removed: 0, added: 0 });
  assert.strictEqual(r.internal.totals.kept, 100);
  assert.deepStrictEqual(r.frame.counts, { kept: 4, removed: 0, added: 0 });
  assert.strictEqual(r.frame.totals.kept, 400);
  assert.deepStrictEqual(r.totals, { kept: 500, removed: 0, added: 0 });
});

test('反向记录不产生差异：同一根铅条起终点颠倒', () => {
  const s1 = snapshot([[[50, 0], [50, 100]]]);
  const s2 = snapshot([[[50, 100], [50, 0]]]);
  const r = D.compareSnapshots(pub(1, 1, s1), pub(2, 2, s2));
  assert.deepStrictEqual(r.internal.counts, { kept: 1, removed: 0, added: 0 });
  // 显示方向归一：朝上
  assert.deepStrictEqual(r.internal.groups[0].fragments.kept[0].from, [50, 0]);
  assert.deepStrictEqual(r.internal.groups[0].fragments.kept[0].to, [50, 100]);
});

test('清单顺序变化不产生差异', () => {
  const s1 = snapshot([[[0, 40], [100, 40]], [[50, 0], [50, 100]]]);
  const s2 = snapshot([[[50, 100], [50, 0]], [[100, 40], [0, 40]]]); // 全反向 + 乱序
  const r = D.compareSnapshots(pub(1, 1, s1), pub(2, 2, s2));
  assert.deepStrictEqual(r.internal.counts, { kept: 2, removed: 0, added: 0 });
  assert.strictEqual(r.internal.totals.kept, 200);
});

test('T 接处分段变化不产生差异：一侧整边、另一侧两段', () => {
  const s1 = snapshot([[[50, 0], [50, 100]]]);
  const s2 = snapshot([[[50, 0], [50, 40], [50, 100]]]); // 中间多出 T 接节点
  const r = D.compareSnapshots(pub(1, 1, s1), pub(2, 2, s2));
  assert.deepStrictEqual(r.internal.counts, { kept: 1, removed: 0, added: 0 });
  assert.strictEqual(r.internal.totals.kept, 100);
});

test('部分重叠必须拆分：重叠段沿用，两端分别取消/新增', () => {
  const s1 = snapshot([[[0, 40], [100, 40]]]);
  const s2 = snapshot([[[30, 40], [130, 40]]]);
  const r = D.compareSnapshots(pub(1, 1, s1), pub(2, 2, s2));
  const f = flatten(r);
  assert.deepStrictEqual(f.removed, [{ from: [0, 40], to: [30, 40], length: 30 }]);
  assert.deepStrictEqual(f.kept, [{ from: [30, 40], to: [100, 40], length: 70 }]);
  assert.deepStrictEqual(f.added, [{ from: [100, 40], to: [130, 40], length: 30 }]);
  assert.deepStrictEqual(r.internal.totals, { kept: 70, removed: 30, added: 30 });
});

test('平行平移（不共线）算取消+新增，不是沿用', () => {
  const s1 = snapshot([[[30, 0], [30, 100]]]);
  const s2 = snapshot([[[70, 0], [70, 100]]]);
  const r = D.compareSnapshots(pub(1, 1, s1), pub(2, 2, s2));
  assert.strictEqual(r.internal.totals.kept, 0);
  assert.strictEqual(r.internal.totals.removed, 100);
  assert.strictEqual(r.internal.totals.added, 100);
});

test('仅端点相触（零长度重叠）不算沿用，且不产生虚假片段', () => {
  const s1 = snapshot([[[0, 40], [50, 40]]]);
  const s2 = snapshot([[[50, 40], [100, 40]]]);
  const r = D.compareSnapshots(pub(1, 1, s1), pub(2, 2, s2));
  assert.strictEqual(r.internal.totals.kept, 0);
  assert.strictEqual(r.internal.totals.removed, 50);
  assert.strictEqual(r.internal.totals.added, 50);
});

test('斜边（无理长度）：片段长度与合计正确，先求和再四舍五入', () => {
  // (0,0)→(3,4) 整数格点方向 (3,4)，长 5
  const s1 = snapshot([[[0, 0], [6, 8]]]); // 长 10
  const s2 = snapshot([[[3, 4], [9, 12]]]); // 与 s1 在 [3,4]..[6,8] 重叠，长 5
  const r = D.compareSnapshots(pub(1, 1, s1), pub(2, 2, s2));
  const f = flatten(r);
  assert.strictEqual(f.removed[0].length, 5);
  assert.strictEqual(f.kept[0].length, 5);
  assert.strictEqual(f.added[0].length, 5);

  // 100√2：单段 141.42；两段 50√2 合计仍为 141.42（先求和再舍入）
  const a = snapshot([[[0, 0], [100, 100]]]);
  const b = snapshot([[[0, 0], [50, 50], [100, 100]]]);
  const r2 = D.compareSnapshots(pub(1, 1, a), pub(2, 2, b));
  assert.strictEqual(r2.internal.totals.kept, 141.42);
  // T 接分段变化本身不产生差异
  assert.strictEqual(r2.internal.counts.kept, 1);
});

test('外框按几何位置识别：清单乱序/反向不产生差异', () => {
  const s1 = snapshot([]);
  const s2 = snapshot([]);
  // 打乱 s2 外框顺序并反向
  const bars = s2.leadList.frameBars;
  s2.leadList.frameBars = [bars[3], bars[1], bars[0], bars[2]].map((b) => ({ ...b, from: b.to, to: b.from }));
  const r = D.compareSnapshots(pub(1, 1, s1), pub(2, 2, s2));
  assert.deepStrictEqual(r.frame.counts, { kept: 4, removed: 0, added: 0 });
  assert.strictEqual(r.frame.totals.kept, 400);
});

test('较早/较晚由版本号自动判定，与入参顺序无关', () => {
  const a = snapshot([[[30, 0], [30, 100]]]);
  const b = snapshot([[[30, 0], [30, 60]]]); // 较早版更长 → 取消 40
  const r = D.compareSnapshots(pub(2, 2, b), pub(1, 1, a)); // 入参故意晚在前
  assert.strictEqual(r.earlier.version, 1);
  assert.strictEqual(r.later.version, 2);
  assert.strictEqual(r.internal.totals.removed, 40);
  assert.strictEqual(r.internal.totals.added, 0);
});

test('同版本自查：全部沿用', () => {
  const s = snapshot([[[50, 0], [50, 100]]]);
  const r = D.compareSnapshots(pub(1, 1, s), pub(1, 1, s));
  assert.strictEqual(r.internal.totals.kept, 100);
  assert.deepStrictEqual(r.totals, { kept: 500, removed: 0, added: 0 });
});

test('窗框尺寸不一致报错 frame_mismatch', () => {
  const s1 = snapshot([], { width: 100, height: 100 });
  const s2 = snapshot([], { width: 120, height: 100 });
  assert.throws(() => D.compareSnapshots(pub(1, 1, s1), pub(2, 2, s2)),
    (e) => e instanceof D.DiffError && e.code === 'frame_mismatch');
});

test('损坏快照：缺少铅条清单 / 外框不足四根 / 坐标超精度', () => {
  const good = snapshot([[[50, 0], [50, 100]]]);
  const noList = { ...good, leadList: null };
  assert.throws(() => D.compareSnapshots(pub(1, 1, noList), pub(2, 2, good)),
    (e) => e.code === 'invalid_snapshot');
  const badFrame = snapshot([[[50, 0], [50, 100]]]);
  badFrame.leadList.frameBars = badFrame.leadList.frameBars.slice(0, 3);
  assert.throws(() => D.compareSnapshots(pub(1, 1, badFrame), pub(2, 2, good)),
    (e) => e.code === 'invalid_snapshot');
  const badCoord = snapshot([[[50, 0], [50, 100.005]]]);
  assert.throws(() => D.compareSnapshots(pub(1, 1, badCoord), pub(2, 2, good)),
    (e) => e.code === 'invalid_snapshot');
});

test('同一几何直线上的不相交多段各自参与比较', () => {
  const s1 = snapshot([[[0, 40], [20, 40]], [[60, 40], [100, 40]]]);
  const s2 = snapshot([[[10, 40], [70, 40]]]);
  const r = D.compareSnapshots(pub(1, 1, s1), pub(2, 2, s2));
  // 沿用 [10,20] 与 [60,70] 两段，合在同一分组，合计 20
  assert.strictEqual(r.internal.totals.kept, 20);
  assert.strictEqual(r.internal.totals.removed, 40);
  assert.strictEqual(r.internal.totals.added, 40);
});
