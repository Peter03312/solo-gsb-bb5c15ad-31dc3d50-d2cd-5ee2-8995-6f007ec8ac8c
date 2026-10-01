'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db;

function init(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- 一张图纸（窗框固定）；草稿内容在 pieces 表中就地编辑
    CREATE TABLE IF NOT EXISTS designs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      width_mm    INTEGER NOT NULL CHECK (width_mm  > 0),
      height_mm   INTEGER NOT NULL CHECK (height_mm > 0),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 草稿拼片：编号在一张图纸内递增且永不复用
    CREATE TABLE IF NOT EXISTS pieces (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id   INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      piece_no    INTEGER NOT NULL,
      color       TEXT    NOT NULL,
      polygon     TEXT    NOT NULL,           -- JSON [[x,y],...] 整数毫米
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (design_id, piece_no)
    );

    -- 发布版：不可变快照，版本号在一张图纸内递增
    CREATE TABLE IF NOT EXISTS publications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id   INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      version     INTEGER NOT NULL,
      snapshot    TEXT    NOT NULL,           -- 完整快照 JSON
      published_at TEXT   NOT NULL DEFAULT (datetime('now')),
      UNIQUE (design_id, version)
    );

    -- 铅条原材：一种规格（定尺长度）一行，登记库存根数
    CREATE TABLE IF NOT EXISTS lead_materials (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE,    -- 规格名（如“6m 通用铅条”）
      length_h    INTEGER NOT NULL CHECK (length_h > 0),   -- 定尺，整数“厘”（0.01mm）
      stock       INTEGER NOT NULL CHECK (stock >= 0),     -- 库存根数（不会为负）
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 铅条生产计划：草稿不预留库存；confirmed 原子预留；canceled 释放。
    -- 绑定发布快照（publication 不可变）；草稿变化/新版本均不影响已确认计划。
    CREATE TABLE IF NOT EXISTS lead_plans (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT    NOT NULL,
      status           TEXT    NOT NULL CHECK (status IN ('draft','confirmed','canceled')),
      publication_id   INTEGER NOT NULL REFERENCES publications(id),
      design_id        INTEGER NOT NULL,
      version          INTEGER NOT NULL,
      material_id      INTEGER NOT NULL REFERENCES lead_materials(id),
      material_name    TEXT    NOT NULL,       -- 快照：确认时的规格名
      material_length_h INTEGER NOT NULL,      -- 快照：建计划时的定尺（厘）
      copies           INTEGER NOT NULL CHECK (copies > 0),
      kerf_h           INTEGER NOT NULL CHECK (kerf_h >= 0),  -- 每刀损耗（厘）
      required_bars    INTEGER NOT NULL CHECK (required_bars > 0),
      segment_count    INTEGER NOT NULL,
      layout           TEXT    NOT NULL,       -- 切段方案 JSON（毫米，排产结果快照）
      created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      confirmed_at     TEXT,
      canceled_at      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pieces_design ON pieces(design_id);
    CREATE INDEX IF NOT EXISTS idx_pub_design    ON publications(design_id);
    CREATE INDEX IF NOT EXISTS idx_plans_status  ON lead_plans(status);
    CREATE INDEX IF NOT EXISTS idx_plans_pub     ON lead_plans(publication_id);
    CREATE INDEX IF NOT EXISTS idx_plans_mat     ON lead_plans(material_id);
  `);
  return db;
}

function getDb() {
  if (!db) throw new Error('数据库未初始化');
  return db;
}

// ---------- designs ----------

function createDesign({ name, width, height }) {
  const info = getDb()
    .prepare('INSERT INTO designs (name, width_mm, height_mm) VALUES (?, ?, ?)')
    .run(name, width, height);
  return getDesign(info.lastInsertRowid);
}

function getDesign(id) {
  return getDb().prepare('SELECT * FROM designs WHERE id = ?').get(id);
}

function listDesigns() {
  return getDb().prepare(`
    SELECT d.*,
      (SELECT COUNT(*) FROM pieces p WHERE p.design_id = d.id) AS piece_count,
      (SELECT MAX(version) FROM publications pu WHERE pu.design_id = d.id) AS latest_version
    FROM designs d ORDER BY d.id
  `).all();
}

// ---------- pieces ----------

function rowToPiece(row) {
  return {
    id: row.id,
    pieceNo: row.piece_no,
    color: row.color,
    polygon: JSON.parse(row.polygon),
    createdAt: row.created_at,
  };
}

function listPieces(designId) {
  return getDb()
    .prepare('SELECT * FROM pieces WHERE design_id = ? ORDER BY piece_no')
    .all(designId)
    .map(rowToPiece);
}

function getPiece(designId, pieceId) {
  const row = getDb()
    .prepare('SELECT * FROM pieces WHERE id = ? AND design_id = ?')
    .get(pieceId, designId);
  return row ? rowToPiece(row) : null;
}

function nextPieceNo(designId) {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(piece_no), 0) + 1 AS n FROM pieces WHERE design_id = ?')
    .get(designId);
  return row.n;
}

function addPiece(designId, { color, polygon }) {
  const pieceNo = nextPieceNo(designId);
  const info = getDb()
    .prepare('INSERT INTO pieces (design_id, piece_no, color, polygon) VALUES (?, ?, ?, ?)')
    .run(designId, pieceNo, color, JSON.stringify(polygon));
  touchDesign(designId);
  return getPiece(designId, info.lastInsertRowid);
}

function updatePiece(designId, pieceId, { color, polygon }) {
  const existing = getPiece(designId, pieceId);
  if (!existing) return null;
  getDb().prepare('UPDATE pieces SET color = ?, polygon = ? WHERE id = ? AND design_id = ?')
    .run(color, JSON.stringify(polygon), pieceId, designId);
  touchDesign(designId);
  return getPiece(designId, pieceId);
}

function deletePiece(designId, pieceId) {
  const info = getDb()
    .prepare('DELETE FROM pieces WHERE id = ? AND design_id = ?')
    .run(pieceId, designId);
  if (info.changes) touchDesign(designId);
  return info.changes > 0;
}

function replaceAllPieces(designId, pieces) {
  // 目前未使用；保留以便整单导入
  const tx = getDb().transaction((rows) => {
    getDb().prepare('DELETE FROM pieces WHERE design_id = ?').run(designId);
    for (const pc of rows) addPiece(designId, pc);
  });
  tx(pieces);
}

function touchDesign(designId) {
  getDb().prepare("UPDATE designs SET updated_at = datetime('now') WHERE id = ?").run(designId);
}

// ---------- publications ----------

function publishVersion(designId, snapshot) {
  const next = nextVersion(designId);
  const info = getDb()
    .prepare('INSERT INTO publications (design_id, version, snapshot) VALUES (?, ?, ?)')
    .run(designId, next, JSON.stringify(snapshot));
  return getPublication(designId, info.lastInsertRowid);
}

function nextVersion(designId) {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM publications WHERE design_id = ?')
    .get(designId);
  return row.v;
}

function getPublication(designId, pubId) {
  const row = getDb()
    .prepare('SELECT * FROM publications WHERE id = ? AND design_id = ?')
    .get(pubId, designId);
  return row ? {
    id: row.id,
    designId: row.design_id,
    version: row.version,
    publishedAt: row.published_at,
    snapshot: JSON.parse(row.snapshot),
  } : null;
}

function getPublicationByVersion(designId, version) {
  const row = getDb()
    .prepare('SELECT * FROM publications WHERE design_id = ? AND version = ?')
    .get(designId, version);
  return row ? {
    id: row.id,
    designId: row.design_id,
    version: row.version,
    publishedAt: row.published_at,
    snapshot: JSON.parse(row.snapshot),
  } : null;
}

function listPublications(designId) {
  return getDb()
    .prepare('SELECT id, version, published_at FROM publications WHERE design_id = ? ORDER BY version DESC')
    .all(designId)
    .map((r) => ({ id: r.id, version: r.version, publishedAt: r.published_at }));
}

// ---------- 铅条原材 ----------

function rowToMaterial(row) {
  return {
    id: row.id,
    name: row.name,
    length: row.length_h / 100,          // 毫米
    stock: row.stock,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 各规格当前已被已确认计划预留的根数
function reservedMap() {
  const rows = getDb()
    .prepare(`SELECT material_id AS id, COALESCE(SUM(required_bars), 0) AS reserved
              FROM lead_plans WHERE status = 'confirmed' GROUP BY material_id`)
    .all();
  const m = new Map();
  for (const r of rows) m.set(r.id, r.reserved);
  return m;
}

function listMaterials() {
  const reserved = reservedMap();
  return getDb()
    .prepare('SELECT * FROM lead_materials ORDER BY id')
    .all()
    .map((r) => {
      const m = rowToMaterial(r);
      const used = reserved.get(r.id) || 0;
      m.reserved = used;
      m.available = m.stock - used;
      return m;
    });
}

function getMaterialRow(id) {
  return getDb().prepare('SELECT * FROM lead_materials WHERE id = ?').get(id);
}

function getMaterial(id) {
  const row = getMaterialRow(id);
  if (!row) return null;
  const m = rowToMaterial(row);
  const reserved = getDb()
    .prepare("SELECT COALESCE(SUM(required_bars),0) AS n FROM lead_plans WHERE material_id = ? AND status = 'confirmed'")
    .get(id).n;
  m.reserved = reserved;
  m.available = m.stock - reserved;
  return m;
}

function getMaterialByName(name) {
  return getDb().prepare('SELECT * FROM lead_materials WHERE name = ?').get(name) || null;
}

function createMaterial({ name, lengthH, stock }) {
  const info = getDb()
    .prepare('INSERT INTO lead_materials (name, length_h, stock) VALUES (?, ?, ?)')
    .run(name, lengthH, stock);
  return getMaterial(info.lastInsertRowid);
}

// 仅允许改名称与库存根数（定尺属于规格身份，改定尺请新建规格）。
// 库存校验在事务中完成：不得小于已预留根数，库存永不为负由 CHECK 兜底。
function updateMaterial(id, { name, stock }) {
  const d = getDb();
  const txn = d.transaction(() => {
    const row = getMaterialRow(id);
    if (!row) return { code: 'not_found' };
    const reserved = d
      .prepare("SELECT COALESCE(SUM(required_bars),0) AS n FROM lead_plans WHERE material_id = ? AND status = 'confirmed'")
      .get(id).n;
    if (stock !== undefined && stock < reserved) {
      return { code: 'stock_below_reserved', reserved };
    }
    if (name !== undefined) {
      const dup = d.prepare('SELECT id FROM lead_materials WHERE name = ? AND id <> ?').get(name, id);
      if (dup) return { code: 'name_taken' };
      d.prepare("UPDATE lead_materials SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, id);
    }
    if (stock !== undefined) {
      d.prepare("UPDATE lead_materials SET stock = ?, updated_at = datetime('now') WHERE id = ?").run(stock, id);
    }
    return { code: 'ok', material: getMaterial(id) };
  });
  return txn.immediate();
}

// ---------- 铅条生产计划 ----------

function getPublicationById(pubId) {
  const row = getDb().prepare('SELECT * FROM publications WHERE id = ?').get(pubId);
  return row ? {
    id: row.id,
    designId: row.design_id,
    version: row.version,
    publishedAt: row.published_at,
    snapshot: JSON.parse(row.snapshot),
  } : null;
}

function createPlan(p) {
  const info = getDb()
    .prepare(`INSERT INTO lead_plans
      (name, status, publication_id, design_id, version, material_id, material_name,
       material_length_h, copies, kerf_h, required_bars, segment_count, layout)
      VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(p.name, p.publicationId, p.designId, p.version, p.materialId,
      p.materialName, p.materialLengthH, p.copies, p.kerfH, p.requiredBars,
      p.segmentCount, JSON.stringify(p.layout));
  return getPlan(info.lastInsertRowid);
}

function getPlanRow(id) {
  return getDb().prepare('SELECT * FROM lead_plans WHERE id = ?').get(id);
}

function rowToPlan(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    publicationId: row.publication_id,
    designId: row.design_id,
    version: row.version,
    materialId: row.material_id,
    materialName: row.material_name,
    materialLength: row.material_length_h / 100,
    copies: row.copies,
    kerf: row.kerf_h / 100,
    requiredBars: row.required_bars,
    segmentCount: row.segment_count,
    layout: JSON.parse(row.layout),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at || null,
    canceledAt: row.canceled_at || null,
  };
}

function getPlan(id) {
  return rowToPlan(getPlanRow(id));
}

function listPlans() {
  return getDb().prepare('SELECT * FROM lead_plans ORDER BY id DESC').all().map(rowToPlan);
}

function updatePlanDraft(id, p) {
  const row = getPlanRow(id);
  if (!row) return { code: 'not_found' };
  if (row.status !== 'draft') return { code: 'not_draft', status: row.status };
  getDb()
    .prepare(`UPDATE lead_plans SET
       name = ?, publication_id = ?, design_id = ?, version = ?, material_id = ?,
       material_name = ?, material_length_h = ?, copies = ?, kerf_h = ?,
       required_bars = ?, segment_count = ?, layout = ?, updated_at = datetime('now')
     WHERE id = ?`)
    .run(p.name, p.publicationId, p.designId, p.version, p.materialId,
      p.materialName, p.materialLengthH, p.copies, p.kerfH, p.requiredBars,
      p.segmentCount, JSON.stringify(p.layout), id);
  return { code: 'ok', plan: getPlan(id) };
}

// 确认：原子预留库存。BEGIN IMMEDIATE 取写锁，保证多个计划并发确认绝不超卖。
function confirmPlan(id) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const row = getPlanRow(id);
    if (!row) { d.exec('ROLLBACK'); return { code: 'not_found' }; }
    if (row.status === 'confirmed') { d.exec('ROLLBACK'); return { code: 'already_confirmed' }; }
    if (row.status === 'canceled') { d.exec('ROLLBACK'); return { code: 'plan_canceled' }; }

    const mat = getMaterialRow(row.material_id);
    if (!mat) { d.exec('ROLLBACK'); return { code: 'material_missing' }; }
    // 规格定尺在建计划后被改动属于不支持的身份变更（当前接口禁止改定尺），双保险
    if (mat.length_h !== row.material_length_h) {
      d.exec('ROLLBACK'); return { code: 'material_changed' };
    }
    const reserved = d
      .prepare("SELECT COALESCE(SUM(required_bars),0) AS n FROM lead_plans WHERE material_id = ? AND status = 'confirmed'")
      .get(row.material_id).n;
    const available = mat.stock - reserved;
    if (row.required_bars > available) {
      d.exec('ROLLBACK');
      return { code: 'shortage', available, required: row.required_bars, shortage: row.required_bars - available };
    }
    d.prepare(`UPDATE lead_plans
      SET status = 'confirmed', material_name = ?, confirmed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'draft'`).run(mat.name, id);
    d.exec('COMMIT');
    return { code: 'ok', plan: getPlan(id) };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// 取消：只有已确认计划会释放预留；重复取消不会再次改变库存。
function cancelPlan(id) {
  const d = getDb();
  const row = getPlanRow(id);
  if (!row) return { code: 'not_found' };
  if (row.status === 'draft') return { code: 'draft_not_reserved' };
  if (row.status === 'canceled') return { code: 'already_canceled' };
  d.exec('BEGIN IMMEDIATE');
  try {
    d.prepare(`UPDATE lead_plans
      SET status = 'canceled', canceled_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'confirmed'`).run(id);
    d.exec('COMMIT');
    return { code: 'ok', plan: getPlan(id) };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

function deletePlan(id) {
  const row = getPlanRow(id);
  if (!row) return { code: 'not_found' };
  if (row.status === 'confirmed') return { code: 'confirmed_delete_blocked' };
  getDb().prepare('DELETE FROM lead_plans WHERE id = ?').run(id);
  return { code: 'ok' };
}

module.exports = {
  init, getDb,
  createDesign, getDesign, listDesigns,
  listPieces, getPiece, addPiece, updatePiece, deletePiece, replaceAllPieces,
  publishVersion, getPublication, getPublicationByVersion, getPublicationById, listPublications,
  listMaterials, getMaterial, getMaterialRow, getMaterialByName, createMaterial, updateMaterial,
  createPlan, getPlan, listPlans, updatePlanDraft, confirmPlan, cancelPlan, deletePlan,
};
