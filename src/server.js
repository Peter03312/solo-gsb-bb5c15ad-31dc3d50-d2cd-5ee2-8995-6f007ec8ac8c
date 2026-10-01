'use strict';

const path = require('path');
const express = require('express');
const db = require('./db');
const geo = require('./geometry');
const cut = require('./cutting');
const leadDiff = require('./leaddiff');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'studio.db');

db.init(DB_PATH);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- 工具 ----------

function fail(res, code, error, extra = {}) {
  return res.status(code).json({ ok: false, error, ...extra });
}

function loadDesignOr404(req, res) {
  const design = db.getDesign(Number(req.params.designId));
  if (!design) {
    fail(res, 404, '图纸不存在');
    return null;
  }
  return design;
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_COLORS = ['#4C9AFF', '#FFAB00', '#36B37E', '#FF5630', '#6554C0', '#00B8D9', '#FF8B00', '#8FAB1E'];

function parsePolygon(body) {
  const poly = body.polygon;
  if (!Array.isArray(poly)) return { error: 'polygon 必须是 [[x,y],...] 数组' };
  const pts = [];
  for (const p of poly) {
    if (!Array.isArray(p) || p.length !== 2 ||
      !Number.isInteger(p[0]) || !Number.isInteger(p[1])) {
      return { error: '每个顶点必须是两个整数毫米坐标' };
    }
    pts.push([p[0], p[1]]);
  }
  return { polygon: pts };
}

// 汇总草稿：片、面积、覆盖状态、缺口、铅条清单
function draftSummary(design) {
  const rows = db.listPieces(design.id);
  const pieces = rows.map((r) => ({
    id: r.id,
    pieceNo: r.pieceNo,
    color: r.color,
    polygon: r.polygon,
    area: geo.round2(geo.polygonArea(r.polygon)),
  }));
  const analysis = geo.analyzePlan(
    { width: design.width_mm, height: design.height_mm },
    rows.map((r) => ({ id: r.id, polygon: r.polygon })),
  );
  return {
    id: design.id,
    name: design.name,
    width: design.width_mm,
    height: design.height_mm,
    createdAt: design.created_at,
    updatedAt: design.updated_at,
    pieces,
    coverage: {
      covered: analysis.covered,
      gaps: analysis.gaps,
      overlapping: analysis.overlapping,
      totalPieceArea: analysis.totalPieceArea,
      frameArea: design.width_mm * design.height_mm,
    },
    leadList: buildLeadList(analysis),
  };
}

// 铅条下料清单：内部公共边合并极大共线段；外框四根另列
function buildLeadList(analysis) {
  const { width, height, total } = analysis.frameLead;
  return {
    internal: analysis.leadRuns.runs.map((r, i) => ({
      no: i + 1,
      points: r.points,
      length: r.length,
    })),
    internalCount: analysis.leadRuns.count,
    internalTotal: analysis.leadRuns.total,
    frameBars: [
      { name: '上框', from: [0, 0], to: [width, 0], length: geo.round2(width) },
      { name: '下框', from: [0, height], to: [width, height], length: geo.round2(width) },
      { name: '左框', from: [0, 0], to: [0, height], length: geo.round2(height) },
      { name: '右框', from: [width, 0], to: [width, height], length: geo.round2(height) },
    ],
    frameTotal: geo.round2(total),
    grandTotal: geo.round2(analysis.leadRuns.total + total),
  };
}

// 对一次新增/编辑做全部几何校验；通过返回 null，否则返回 422 响应体
function validateEdit(design, candidatePolygon, ignorePieceId) {
  const frame = { width: design.width_mm, height: design.height_mm };

  const self = geo.validatePolygon(candidatePolygon);
  if (!self.ok) {
    return { error: self.reason, category: 'invalid', at: self.at || null };
  }
  const others = db.listPieces(design.id)
    .filter((r) => r.id !== ignorePieceId)
    .map((r) => ({ id: r.id, polygon: r.polygon }));
  // checkAgainstPieces 内部统一做越界（矩形窗框为凸集，顶点在内则边在内）与重叠校验
  const rel = geo.checkAgainstPieces(candidatePolygon, others, frame);
  if (!rel.ok) {
    return {
      error: rel.reason,
      category: 'overlap',
      at: rel.at ? rel.at.slice() : null,
      pieceId: rel.pieceId || null,
    };
  }
  return null;
}

// ---------- 图纸 ----------

app.get('/api/designs', (req, res) => {
  res.json({ ok: true, designs: db.listDesigns() });
});

app.post('/api/designs', (req, res) => {
  const { name } = req.body || {};
  const width = Number(req.body?.width);
  const height = Number(req.body?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return fail(res, 400, '窗框宽高必须是正整数毫米');
  }
  if (width > 100000 || height > 100000) {
    return fail(res, 400, '窗框尺寸过大（上限 100000 毫米）');
  }
  const design = db.createDesign({
    name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : '未命名图纸',
    width, height,
  });
  res.status(201).json({ ok: true, design });
});

app.get('/api/designs/:designId', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  res.json({ ok: true, draft: draftSummary(design) });
});

// ---------- 草稿拼片 ----------

app.post('/api/designs/:designId/pieces', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const parsed = parsePolygon(req.body || {});
  if (parsed.error) return fail(res, 400, parsed.error);
  let color = (req.body.color || '').trim();
  if (!color) color = DEFAULT_COLORS[db.listPieces(design.id).length % DEFAULT_COLORS.length];
  if (!COLOR_RE.test(color)) return fail(res, 400, '颜色必须是 #RRGGBB 形式');

  const problem = validateEdit(design, parsed.polygon, null);
  if (problem) return res.status(422).json({ ok: false, ...problem });

  const piece = db.addPiece(design.id, { color, polygon: parsed.polygon });
  res.status(201).json({ ok: true, piece: withArea(piece), draft: draftSummary(db.getDesign(design.id)) });
});

app.put('/api/designs/:designId/pieces/:pieceId', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const pieceId = Number(req.params.pieceId);
  const existing = db.getPiece(design.id, pieceId);
  if (!existing) return fail(res, 404, '拼片不存在');

  const parsed = parsePolygon(req.body || {});
  if (parsed.error) return fail(res, 400, parsed.error);
  const color = (req.body.color || '').trim();
  if (!COLOR_RE.test(color)) return fail(res, 400, '颜色必须是 #RRGGBB 形式');

  const problem = validateEdit(design, parsed.polygon, pieceId);
  if (problem) return res.status(422).json({ ok: false, ...problem });

  const updated = db.updatePiece(design.id, pieceId, { color, polygon: parsed.polygon });
  res.json({ ok: true, piece: withArea(updated), draft: draftSummary(db.getDesign(design.id)) });
});

app.delete('/api/designs/:designId/pieces/:pieceId', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const removed = db.deletePiece(design.id, Number(req.params.pieceId));
  if (!removed) return fail(res, 404, '拼片不存在');
  res.json({ ok: true, draft: draftSummary(db.getDesign(design.id)) });
});

function withArea(piece) {
  return { ...piece, area: geo.round2(geo.polygonArea(piece.polygon)) };
}

// ---------- 发布 ----------

app.get('/api/designs/:designId/publications', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  res.json({ ok: true, publications: db.listPublications(design.id) });
});

app.post('/api/designs/:designId/publish', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const summary = draftSummary(design);
  if (summary.pieces.length === 0) {
    return fail(res, 422, '草稿为空，不能发布');
  }
  if (!summary.coverage.covered) {
    return res.status(422).json({
      ok: false,
      error: '草稿未完整覆盖窗框或存在重叠，不能发布',
      category: 'not_covered',
      gaps: summary.coverage.gaps,
      overlapping: summary.coverage.overlapping,
    });
  }
  const snapshot = {
    name: summary.name,
    width: summary.width,
    height: summary.height,
    pieces: summary.pieces,
    leadList: summary.leadList,
    frameArea: summary.coverage.frameArea,
  };
  const pub = db.publishVersion(design.id, snapshot);
  res.status(201).json({ ok: true, publication: pub });
});

// 核对两个发布版的铅条下料差异（只读，不改快照/计划/库存）。
// 结果以较早版为基准：kept 沿用 / removed 较早版取消 / added 较晚版新增。
// 若两版顺序颠倒，自动按版本号交换。
function buildPublicationDiff(pubA, pubB) {
  const [earlier, later] = pubA.version <= pubB.version ? [pubA, pubB] : [pubB, pubA];
  const r = leadDiff.diffPublications(earlier, later);
  if (!r.ok) return { error: r.error, status: 422 };
  return {
    meta: {
      designId: earlier.designId,
      designName: earlier.snapshot.name,
      earlier: { id: earlier.id, version: earlier.version, publishedAt: earlier.publishedAt },
      later: { id: later.id, version: later.version, publishedAt: later.publishedAt },
      width: later.snapshot.width,
      height: later.snapshot.height,
    },
    diff: r.comparison,
  };
}

// GET：同一图纸 + 两个版本号（最易在浏览器/curl 调用）
//   /api/designs/:designId/publications/diff?fromVersion=1&toVersion=2
app.get('/api/designs/:designId/publications/diff', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const fromVersion = Number(req.query.fromVersion);
  const toVersion = Number(req.query.toVersion);
  if (!Number.isInteger(fromVersion) || !Number.isInteger(toVersion) ||
      fromVersion <= 0 || toVersion <= 0) {
    return fail(res, 400, 'fromVersion/toVersion 必须是正整数版本号');
  }
  const pubA = db.getPublicationByVersion(design.id, fromVersion);
  if (!pubA) return fail(res, 404, `发布版 v${fromVersion} 不存在`);
  const pubB = db.getPublicationByVersion(design.id, toVersion);
  if (!pubB) return fail(res, 404, `发布版 v${toVersion} 不存在`);
  const built = buildPublicationDiff(pubA, pubB);
  if (built.error) return fail(res, built.status, built.error);
  res.json({ ok: true, ...built });
});

// POST：两个发布版 id（可跨图纸时明确报错）
//   { publicationIdA: 1, publicationIdB: 2 }
app.post('/api/publications/diff', (req, res) => {
  const body = req.body || {};
  const idA = Number(body.publicationIdA);
  const idB = Number(body.publicationIdB);
  if (!Number.isInteger(idA) || !Number.isInteger(idB) || idA <= 0 || idB <= 0) {
    return fail(res, 400, 'publicationIdA/publicationIdB 必须是发布版的正整数 id');
  }
  const pubA = db.getPublicationById(idA);
  if (!pubA) return fail(res, 404, `发布版 id=${idA} 不存在`);
  const pubB = db.getPublicationById(idB);
  if (!pubB) return fail(res, 404, `发布版 id=${idB} 不存在`);
  if (pubA.designId !== pubB.designId) {
    return fail(res, 400, '两个发布版不属于同一图纸，不能核对铅条', {
      designIdA: pubA.designId,
      designIdB: pubB.designId,
    });
  }
  const built = buildPublicationDiff(pubA, pubB);
  if (built.error) return fail(res, built.status, built.error);
  res.json({ ok: true, ...built });
});

app.get('/api/designs/:designId/publications/:version', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const pub = db.getPublicationByVersion(design.id, Number(req.params.version));
  if (!pub) return fail(res, 404, '发布版不存在');
  res.json({ ok: true, publication: pub });
});

// ---------- 铅条原材库存 ----------

const MATERIAL_NAME_MAX = 80;

app.get('/api/materials', (req, res) => {
  res.json({ ok: true, materials: db.listMaterials() });
});

app.get('/api/materials/:materialId', (req, res) => {
  const material = db.getMaterial(Number(req.params.materialId));
  if (!material) return fail(res, 404, '原材规格不存在');
  res.json({ ok: true, material });
});

app.post('/api/materials', (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return fail(res, 400, '规格名称必填');
  if (name.length > MATERIAL_NAME_MAX) return fail(res, 400, `规格名称不得超过 ${MATERIAL_NAME_MAX} 字`);
  const len = cut.parseLen2(Number(body.length), { name: '原材定尺', positive: true });
  if (!len.ok) return fail(res, 400, len.error);
  const stock = cut.parseNonNegInt(Number(body.stock), { name: '库存根数', max: 1e9 });
  if (!stock.ok) return fail(res, 400, stock.error);
  if (db.getMaterialByName(name)) return fail(res, 409, '同名规格已存在');
  const material = db.createMaterial({ name, lengthH: len.h, stock: stock.n });
  res.status(201).json({ ok: true, material });
});

// 修改规格名/库存根数（定尺不可改）。库存不得小于已预留根数。
app.patch('/api/materials/:materialId', (req, res) => {
  const material = db.getMaterial(Number(req.params.materialId));
  if (!material) return fail(res, 404, '原材规格不存在');
  const body = req.body || {};
  const fields = {};
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return fail(res, 400, '规格名称必填');
    if (name.length > MATERIAL_NAME_MAX) return fail(res, 400, `规格名称不得超过 ${MATERIAL_NAME_MAX} 字`);
    fields.name = name;
  }
  if (body.stock !== undefined) {
    const stock = cut.parseNonNegInt(Number(body.stock), { name: '库存根数', max: 1e9 });
    if (!stock.ok) return fail(res, 400, stock.error);
    fields.stock = stock.n;
  }
  if (body.length !== undefined) {
    return fail(res, 400, '定尺属于规格身份不可修改；请新建规格');
  }
  if (!('name' in fields) && !('stock' in fields)) {
    return fail(res, 400, '没有可更新字段（name 或 stock）');
  }
  const r = db.updateMaterial(material.id, fields);
  if (r.code === 'name_taken') return fail(res, 409, '同名规格已存在');
  if (r.code === 'stock_below_reserved') {
    return fail(res, 409, `库存不得小于已确认计划预留根数（${r.reserved}）`, { reserved: r.reserved });
  }
  res.json({ ok: true, material: r.material });
});

// ---------- 铅条生产计划 ----------

const PLAN_NAME_MAX = 80;
const COPIES_MAX = 10000;

// 解析并校验排产参数；返回 { error }（HTTP 层据此拒绝，且绝不改库存）或 { pub, material, copies, kerfH }
function resolvePlanInputs(body) {
  const publicationId = Number(body.publicationId);
  if (!Number.isInteger(publicationId) || publicationId <= 0) {
    return { error: 'publicationId 必须是已发布版本的正整数 id' };
  }
  const pub = db.getPublicationById(publicationId);
  if (!pub) return { error: '发布版不存在', status: 404 };

  const materialId = Number(body.materialId);
  if (!Number.isInteger(materialId) || materialId <= 0) {
    return { error: 'materialId 必须是原材规格的正整数 id' };
  }
  const material = db.getMaterial(materialId);
  if (!material) return { error: '原材规格不存在', status: 404 };
  // 精确定尺（整数厘）取自数据库原始行，不走毫米浮点往返
  const materialRow = db.getMaterialRow(materialId);
  material.lengthH = materialRow.length_h;

  const copiesR = cut.parsePositiveInt(Number(body.copies), { name: '件数', max: COPIES_MAX });
  if (!copiesR.ok) return { error: copiesR.error };

  const kerfR = cut.parseLen2(Number(body.kerf), { name: '每刀损耗', positive: false });
  if (!kerfR.ok) return { error: kerfR.error };

  return { pub, material, copies: copiesR.n, kerfH: kerfR.h };
}

// 依据发布快照 + 参数生成切段方案（长度均换算为毫米输出，不访问/修改库存计数）
function buildPlanLayout({ pub, material, copies, kerfH }) {
  const segs = cut.segmentsFromSnapshot(pub.snapshot);
  if (!segs.ok) return { error: segs.error };
  const result = cut.planCuts({
    segments: segs.segments,
    copies,
    stockLenH: material.lengthH,
    kerfH,
  });
  if (!result.ok) {
    if (result.code === 'segment_too_long') {
      return {
        error: result.error,
        status: 422,
        code: result.code,
        segment: serializeSegmentBrief(result.segment, kerfH),
      };
    }
    return { error: result.error, status: 400, code: result.code };
  }
  return { layout: serializeLayout(result, material) };
}

function serializeSegmentBrief(seg, kerfH) {
  return {
    name: seg.name,
    source: seg.source,
    length: cut.hToMm(seg.lengthH),
    withKerf: cut.hToMm(seg.lengthH + kerfH),
  };
}

function serializeLayout(result, material) {
  const kerfH = result.segmentCount ? result.totalKerfH / result.segmentCount : 0;
  return {
    materialLength: cut.hToMm(material.lengthH),
    kerf: cut.hToMm(kerfH),
    segmentCount: result.segmentCount,
    requiredBars: result.requiredBars,
    totals: {
      segmentCount: result.segmentCount,
      finishedLength: cut.hToMm(result.totalFinishedH),
      kerfTotal: cut.hToMm(result.totalKerfH),
      remainderTotal: cut.hToMm(result.totalRemainderH),
    },
    bars: result.bars.map((b) => ({
      index: b.index,
      usedLength: cut.hToMm(b.usedH),
      remainder: cut.hToMm(b.remainderH),
      cuts: b.cuts.map((c) => ({
        piece: c.piece,
        source: c.source,
        sourceNo: c.sourceNo,
        name: c.name,
        length: cut.hToMm(c.lengthH),
        kerf: cut.hToMm(c.kerfH),
        from: c.from,
        to: c.to,
      })),
    })),
  };
}

// 预览（POST /api/plans/preview）：不落库、不预留
app.post('/api/plans/preview', (req, res) => {
  const body = req.body || {};
  const inp = resolvePlanInputs(body);
  if (inp.error) return fail(res, inp.status || 400, inp.error);
  const built = buildPlanLayout(inp);
  if (built.error) {
    return res.status(built.status || 400).json({
      ok: false, error: built.error, code: built.code, segment: built.segment || undefined,
    });
  }
  const material = db.getMaterial(inp.material.id); // 取最新 stock/reserved/available
  const shortage = Math.max(0, built.layout.requiredBars - material.available);
  res.json({
    ok: true,
    preview: {
      publicationId: inp.pub.id,
      designId: inp.pub.designId,
      version: inp.pub.version,
      copies: inp.copies,
      kerf: cut.hToMm(inp.kerfH),
      material: materialBrief(material),
      layout: built.layout,
      requiredBars: built.layout.requiredBars,
      availableBars: material.available,
      shortage,
      feasible: shortage === 0,
    },
  });
});

// 建草稿计划
app.post('/api/plans', (req, res) => {
  const body = req.body || {};
  const inp = resolvePlanInputs(body);
  if (inp.error) return fail(res, inp.status || 400, inp.error);
  const built = buildPlanLayout(inp);
  if (built.error) {
    return res.status(built.status || 400).json({
      ok: false, error: built.error, code: built.code, segment: built.segment || undefined,
    });
  }
  const name = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim().slice(0, PLAN_NAME_MAX)
    : `v${inp.pub.version} ×${inp.copies}件 · ${inp.material.name}`;
  const plan = db.createPlan({
    name,
    publicationId: inp.pub.id,
    designId: inp.pub.designId,
    version: inp.pub.version,
    materialId: inp.material.id,
    materialName: inp.material.name,
    materialLengthH: inp.material.lengthH,
    copies: inp.copies,
    kerfH: inp.kerfH,
    requiredBars: built.layout.requiredBars,
    segmentCount: built.layout.segmentCount,
    layout: built.layout,
  });
  res.status(201).json({ ok: true, plan: serializePlan(plan) });
});

app.get('/api/plans', (req, res) => {
  res.json({ ok: true, plans: db.listPlans().map(serializePlan) });
});

app.get('/api/plans/:planId', (req, res) => {
  const plan = db.getPlan(Number(req.params.planId));
  if (!plan) return fail(res, 404, '生产计划不存在');
  res.json({ ok: true, plan: serializePlan(plan) });
});

// 修改草稿（重新选版本/件数/原材/刀损并重算切段）
app.put('/api/plans/:planId', (req, res) => {
  const plan = db.getPlan(Number(req.params.planId));
  if (!plan) return fail(res, 404, '生产计划不存在');
  if (plan.status !== 'draft') {
    return fail(res, 409, `仅草稿计划可修改（当前为 ${statusZh(plan.status)}）`);
  }
  const body = req.body || {};
  // 未传字段沿用旧值
  const merged = {
    publicationId: body.publicationId !== undefined ? Number(body.publicationId) : plan.publicationId,
    materialId: body.materialId !== undefined ? Number(body.materialId) : plan.materialId,
    copies: body.copies !== undefined ? Number(body.copies) : plan.copies,
    kerf: body.kerf !== undefined ? Number(body.kerf) : plan.kerf,
  };
  const inp = resolvePlanInputs(merged);
  if (inp.error) return fail(res, inp.status || 400, inp.error);
  const built = buildPlanLayout(inp);
  if (built.error) {
    return res.status(built.status || 400).json({
      ok: false, error: built.error, code: built.code, segment: built.segment || undefined,
    });
  }
  const name = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim().slice(0, PLAN_NAME_MAX)
    : plan.name;
  const r = db.updatePlanDraft(plan.id, {
    name,
    publicationId: inp.pub.id,
    designId: inp.pub.designId,
    version: inp.pub.version,
    materialId: inp.material.id,
    materialName: inp.material.name,
    materialLengthH: inp.material.lengthH,
    copies: inp.copies,
    kerfH: inp.kerfH,
    requiredBars: built.layout.requiredBars,
    segmentCount: built.layout.segmentCount,
    layout: built.layout,
  });
  if (r.code !== 'ok') return fail(res, 409, '计划状态已变化，请刷新后重试');
  res.json({ ok: true, plan: serializePlan(r.plan) });
});

// 确认：原子预留库存；重复确认不会重复扣减
app.post('/api/plans/:planId/confirm', (req, res) => {
  const plan = db.getPlan(Number(req.params.planId));
  if (!plan) return fail(res, 404, '生产计划不存在');
  const r = db.confirmPlan(plan.id);
  if (r.code === 'already_confirmed') {
    return res.status(409).json({ ok: false, error: '计划已确认，无需重复确认（库存未重复预留）', plan: serializePlan(db.getPlan(plan.id)) });
  }
  if (r.code === 'plan_canceled') return fail(res, 409, '计划已取消，不能确认；请新建计划');
  if (r.code === 'material_missing') return fail(res, 409, '原材规格已不存在，无法确认');
  if (r.code === 'material_changed') {
    return fail(res, 409, '原材定尺自计划创建后已变化，请按新规格重建计划');
  }
  if (r.code === 'shortage') {
    return res.status(409).json({
      ok: false,
      error: `可用原材不足：需用 ${r.required} 根，当前可用 ${r.available} 根，缺口 ${r.shortage} 根，不能确认`,
      code: 'shortage',
      requiredBars: r.required,
      availableBars: r.available,
      shortage: r.shortage,
    });
  }
  res.json({ ok: true, plan: serializePlan(r.plan) });
});

// 取消：仅释放一次预留；重复取消不重复改库存
app.post('/api/plans/:planId/cancel', (req, res) => {
  const plan = db.getPlan(Number(req.params.planId));
  if (!plan) return fail(res, 404, '生产计划不存在');
  const r = db.cancelPlan(plan.id);
  if (r.code === 'draft_not_reserved') {
    return fail(res, 409, '草稿计划尚未预留库存，无需取消（可直接删除）');
  }
  if (r.code === 'already_canceled') {
    return res.status(409).json({ ok: false, error: '计划已取消，库存此前已释放，未重复变更', plan: serializePlan(db.getPlan(plan.id)) });
  }
  res.json({ ok: true, plan: serializePlan(r.plan) });
});

// 删除草稿/已取消计划（已确认计划须先取消）
app.delete('/api/plans/:planId', (req, res) => {
  const r = db.deletePlan(Number(req.params.planId));
  if (r.code === 'not_found') return fail(res, 404, '生产计划不存在');
  if (r.code === 'confirmed_delete_blocked') {
    return fail(res, 409, '已确认计划不能删除；请先取消以释放库存');
  }
  res.json({ ok: true });
});

function materialBrief(material) {
  return {
    id: material.id,
    name: material.name,
    length: material.length,
    stock: material.stock,
    reserved: material.reserved,
    available: material.available,
  };
}

function statusZh(status) {
  return status === 'draft' ? '草稿' : status === 'confirmed' ? '已确认' : '已取消';
}

// 计划输出：绑定的发布版本与排产方案为快照；同时附带当前库存视图供网页展示
function serializePlan(plan) {
  const material = db.getMaterial(plan.materialId);
  const shortage = Math.max(0, plan.requiredBars - (material ? material.available : 0));
  return {
    id: plan.id,
    name: plan.name,
    status: plan.status,
    statusText: statusZh(plan.status),
    publicationId: plan.publicationId,
    designId: plan.designId,
    version: plan.version,
    copies: plan.copies,
    kerf: plan.kerf,
    requiredBars: plan.requiredBars,
    segmentCount: plan.segmentCount,
    layout: plan.layout,
    material: material
      ? materialBrief(material)
      : { id: plan.materialId, name: plan.materialName, length: plan.materialLength, unavailable: true },
    availableBars: material ? material.available : 0,
    shortage: plan.status === 'draft' ? shortage : 0,
    feasible: plan.status !== 'draft' || shortage === 0,
    snapshotBound: true,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    confirmedAt: plan.confirmedAt,
    canceledAt: plan.canceledAt,
  };
}

// 前端单页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// 统一错误处理
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError) return fail(res, 400, '请求体不是合法 JSON');
  console.error(err);
  fail(res, 500, '服务器内部错误');
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`彩绘玻璃拼片台已启动: http://localhost:${PORT}`);
    console.log(`数据库文件: ${DB_PATH}`);
  });
}

module.exports = app;
