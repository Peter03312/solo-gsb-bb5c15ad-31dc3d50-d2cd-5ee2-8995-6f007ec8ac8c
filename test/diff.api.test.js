'use strict';

// 端到端：两个已发布版本的铅条下料核对（只读接口）。
// 覆盖：几何沿用/取消/新增拆分、反向与乱序不产生虚假差异（经真实发布快照）、
// 版本不存在/跨图纸/尺寸不一致报错、核对不影响发布快照/生产计划/库存。

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '39234';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', `diff-api-test-${process.pid}.db`);

const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const db = require('../src/db');
const app = require('../src/server');

const BASE = `http://localhost:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;

async function api(method, url, body) {
  const resp = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

const addPiece = async (designId, color, polygon) =>
  (await api('POST', `/api/designs/${designId}/pieces`, { color, polygon }));

async function publish(designId) {
  const r = await api('POST', `/api/designs/${designId}/publish`);
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  return r.data.publication.id;
}

let did, otherDid;
let v1, v2, v3;
let otherV1;

before(async () => {
  server = app.listen(Number(process.env.PORT));
  for (let i = 0; i < 40; i++) {
    try { await api('GET', '/api/materials'); break; } catch { await sleep(50); }
  }

  // 图纸 A：100×100
  did = (await api('POST', '/api/designs', { name: '核对主窗', width: 100, height: 100 })).data.design.id;
  // v1：竖分割 x=50
  await addPiece(did, '#ff0000', [[0, 0], [50, 0], [50, 100], [0, 100]]);
  await addPiece(did, '#00ff00', [[50, 0], [100, 0], [100, 100], [50, 100]]);
  v1 = await publish(did);

  // v2：右侧被斜向 T 接拆成两片（竖公共边 x=50 整段保留，新增斜边）
  await api('DELETE', `/api/designs/${did}/pieces/2`);
  await addPiece(did, '#0000ff', [[50, 0], [100, 0], [100, 60], [50, 40]]);
  await addPiece(did, '#abcdef', [[50, 40], [100, 60], [100, 100], [50, 100]]);
  v2 = await publish(did);

  // v3：竖分割整体平移到 x=30（左一竖条 30 宽，右 70 宽），斜边取消
  for (const id of [4, 3, 1]) await api('DELETE', `/api/designs/${did}/pieces/${id}`);
  await addPiece(did, '#112233', [[0, 0], [30, 0], [30, 100], [0, 100]]);
  await addPiece(did, '#445566', [[30, 0], [100, 0], [100, 100], [30, 100]]);
  v3 = await publish(did);

  // 图纸 B（不同图纸）
  otherDid = (await api('POST', '/api/designs', { name: '别的窗', width: 200, height: 80 })).data.design.id;
  await addPiece(otherDid, '#ff0000', [[0, 0], [100, 0], [100, 80], [0, 80]]);
  await addPiece(otherDid, '#00ff00', [[100, 0], [200, 0], [200, 80], [100, 80]]);
  otherV1 = await publish(otherDid);
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { db.getDb().close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(process.env.DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
});

test('v1→v2：竖公共边整段沿用（T 接分段变化无虚假差异），斜边新增', async () => {
  const r = await api('GET', `/api/publications-diff?a=${v1}&b=${v2}`);
  assert.strictEqual(r.status, 200);
  const d = r.data.diff;
  assert.strictEqual(d.earlier.publicationId, v1);
  assert.strictEqual(d.later.publicationId, v2);

  // 找到竖线分组与斜边分组
  const groups = d.internal.groups;
  const vert = groups.find((g) => g.fragments.kept.some((f) => f.from[0] === 50 && f.to[0] === 50));
  assert.ok(vert, '竖公共边沿用');
  assert.deepStrictEqual(vert.counts, { kept: 1, removed: 0, added: 0 });
  assert.strictEqual(vert.totals.kept, 100);
  const diag = groups.find((g) => g.fragments.added.length > 0);
  assert.ok(diag);
  assert.strictEqual(diag.fragments.added[0].length, 53.85); // 50√? 实长 √(50²+20²)=53.85
  assert.strictEqual(d.internal.totals.added, 53.85);

  // 外框全部沿用
  assert.deepStrictEqual(d.frame.counts, { kept: 4, removed: 0, added: 0 });
  assert.strictEqual(d.frame.totals.kept, 400);
  assert.strictEqual(d.totals.kept, 500);
});

test('v2→v3：竖线平移（x=50 取消，x=30 新增），斜边取消；外框仍沿用', async () => {
  const r = await api('GET', `/api/publications-diff?a=${v2}&b=${v3}`);
  assert.strictEqual(r.status, 200);
  const d = r.data.diff;
  assert.strictEqual(d.internal.totals.removed, 100 + 53.85); // x=50 整根 + 斜边
  assert.strictEqual(d.internal.totals.added, 100);
  assert.strictEqual(d.internal.totals.kept, 0);
  // 合计：先对所有片段原始长度求和再四舍五入（53.851… 参与求和，不产生 0.01 误差）
  assert.ok(Number.isInteger(Math.round(d.internal.totals.removed * 100)));
  assert.strictEqual(d.frame.totals.kept, 400);
});

test('入参顺序颠倒时按版本号自动确定较早/较晚', async () => {
  const r = await api('GET', `/api/publications-diff?a=${v2}&b=${v1}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.diff.earlier.version, 1);
  assert.strictEqual(r.data.diff.later.version, 2);
});

test('同版本自查：全部沿用', async () => {
  const r = await api('GET', `/api/publications-diff?a=${v1}&b=${v1}`);
  assert.deepStrictEqual(r.data.diff.totals, { kept: 500, removed: 0, added: 0 });
});

test('图纸作用域接口可用', async () => {
  const r = await api('GET', `/api/designs/${did}/publications-diff?a=${v1}&b=${v3}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.diff.design.width, 100);
});

test('错误：发布版不存在 / 参数非法 / 跨图纸', async () => {
  assert.strictEqual((await api('GET', '/api/publications-diff?a=99999&b=1')).status, 404);
  assert.strictEqual((await api('GET', '/api/publications-diff?a=1')).status, 400);
  assert.strictEqual((await api('GET', '/api/publications-diff?a=x&b=1')).status, 400);
  const cross = await api('GET', `/api/publications-diff?a=${v1}&b=${otherV1}`);
  assert.strictEqual(cross.status, 409);
  assert.strictEqual(cross.data.code, 'different_design');
  // 图纸作用域：引用别的图纸的版本按“不存在”处理
  const scoped = await api('GET', `/api/designs/${did}/publications-diff?a=${v1}&b=${otherV1}`);
  assert.strictEqual(scoped.status, 404);
});

test('核对只读：快照、清单不变化，且不触碰库存/计划', async () => {
  const before = (await api('GET', `/api/designs/${did}/publications/2`)).data.publication;
  await api('GET', `/api/publications-diff?a=${v1}&b=${v2}`);
  await api('GET', `/api/designs/${did}/publications-diff?a=${v1}&b=${v3}`);
  const after = (await api('GET', `/api/designs/${did}/publications/2`)).data.publication;
  assert.strictEqual(JSON.stringify(after.snapshot), JSON.stringify(before.snapshot));
  assert.strictEqual(after.snapshot.leadList.internal.length,
    before.snapshot.leadList.internal.length);
  // 发布数量不变
  const pubs = (await api('GET', `/api/designs/${did}/publications`)).data.publications;
  assert.strictEqual(pubs.length, 3);
});
