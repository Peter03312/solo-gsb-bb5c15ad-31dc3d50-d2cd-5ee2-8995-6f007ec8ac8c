# 彩绘玻璃工作室 · 网页拼片台

为彩绘玻璃工作室设计的网页拼片台：输入矩形窗框的正整数毫米宽高，在画布上以**整数毫米坐标**绘制带**编号与颜色**的简单多边形玻璃片；服务端精确校验每一次编辑，只有**完整覆盖窗框且无空隙**的草稿才能发布；发布时生成**铅条下料清单**（公共边只计一次，外框另列）。历史发布版不可变，随时查阅。

围绕已发布图纸还可**安排铅条生产**：登记铅条原材定尺与库存根数，选择发布版本、件数、原材规格与每刀损耗进行排产；系统按 0.01 mm 精确计算切段方案，确认时**原子预留库存**（并发不超卖），计划永久绑定发布快照。

工作室调整拼片并再次发布后，还可选择**同一图纸的任意两个已发布版本核对铅条下料变化**：按几何位置比较内部公共边与四根外框，区分沿用/取消/新增，部分重叠自动拆分；核对全程**只读**，不影响发布快照、生产计划与库存。

## 功能一览

- **窗框建模**：宽、高为正整数毫米（1–100000）。
- **拼片绘制**：画布点击取点（自动吸附已有顶点/窗框角），双击或“闭合多边形”完成；也可直接输入 `x,y` 坐标。每片有独立编号与颜色。
- **编辑校验（拒绝并标出位置，图中红色 ✕ 标记）**：
  - 顶点必须是整数毫米，且在窗框内 —— 越界拒绝；
  - 必须是简单多边形：自交（边交叉/边重叠/非端点相触）、重复顶点、零边、相邻共线均拒绝；
  - 与现有拼片**面积重叠**拒绝（边交叉、顶点穿入、共边同侧重叠、顶点处内角相交）；
  - 允许合法相邻：共边共享、T 接、顶点相接；
  - **允许相邻片边界一侧是整边、另一侧为数段**。
- **覆盖检查与缺口可视化**：未发布前实时分析草稿，缺口区域以红色斜纹多边形标出并给出每块缺口面积；面积重叠以紫色标出。
- **发布**：仅当无缺口、无重叠、面积合计等于窗框面积时可发布，否则返回 422 并附带缺口数据。发布版带递增版本号，快照不可变。
- **发布图纸**：展示每片编号、颜色与面积（mm²），画布上直接标注编号与面积。
- **铅条下料清单**：
  - 内部公共边无论怎样分段都**合并为一根、只计一次**（T 接处直线继续则不断开）；
  - 外框四根（上/下/左/右）另列；
  - 每根长度、分类小计与总长都是**先求和再四舍五入至 0.01 mm**。
- **草稿/发布分离**：后续编辑、删除、改色与清单重算只作用于草稿；历史发布版通过版本下拉框查阅，内容永不变化。
- **两版铅条核对（本轮新增）**：
  - 选择同一图纸的两个已发布版本，分别比较**内部公共边**与**四根外框**（上/下/左/右）；
  - 两版**共线且空间重叠**的部分为**沿用**，仅较早版覆盖为**取消**，仅较晚版覆盖为**新增**，部分重叠在端点处**自动拆分**；
  - 比较前做无向直线归一与同版区间合并：**反向记录、清单顺序变化、T 接处分段变化（一侧整边/另一侧数段）都不产生虚假差异**；
  - 展示每类线段的起点/终点（mm）、长度（mm）与分类合计；各类合计**先求和再四舍五入到 0.01 mm**；
  - 版本不存在、两个发布版不属于同一图纸时**明确报错**；核对为**只读**，发布快照、生产计划、库存均不变化。
- **铅条生产（本轮新增）**：
  - **原材登记**：登记原材规格名、**定尺长度**（正数，精确到 0.01 mm）与**库存根数**（非负整数）；非法输入一律拒绝且不改库存。
  - **排产取段**：只取所选**发布版本**铅条清单中的**内部公共边**与**四根外框**（上/下/左/右），按**件数**逐件展开，每一段都是**不可拼接**的独立切段。
  - **切段规则**：切段按长度**降序**排列，同长按清单顺序；依次放入**第一根能容纳**它的原材（首次适应递减 FFD）。每段占用 `成品长度 + 一刀损耗`，放不下就开新原材；输出逐根切段、每根余料与需用根数。
  - **预览不占库存**：任何非法输入、单段连同刀损超过定尺（整单拒绝）都不会改动库存。
  - **缺口与确认**：需用根数超过可用数时返回**缺口根数且不能确认**；确认在一个 `BEGIN IMMEDIATE` 事务中**原子预留**，多计划并发也**不会超卖**。
  - **幂等与释放**：重复确认不会重复预留；取消只释放一次，重复取消不重复改库存；已确认计划不可删除（须先取消）。
  - **快照绑定**：计划一旦建立即绑定该发布版本，后续草稿改动或再发布新版本**都不影响**其用料。
  - 网页“铅条生产”标签可登记库存、预览、确认/取消计划并查看可用库存。

## 技术栈

- Node.js ≥ 20（CommonJS）
- Express 4（Web/API/静态资源）
- better-sqlite3（SQLite，同步事务）
- 原生 HTML/CSS/Canvas + 原生 JS（无前端构建步骤）
- 几何判定全部使用整数坐标的精确整数运算（叉积/射线法），交点以精确分数表示，避免浮点误差

## 快速启动

### 方式一：Docker Compose（推荐，一键启动并初始化数据库）

```bash
docker compose up -d --build
```

首次启动会自动构建镜像、安装依赖，并在容器内对 `/data/studio.db` 执行建表初始化
（`CREATE TABLE IF NOT EXISTS`），无需手动初始化。

浏览器打开：

```
http://localhost:3000
```

停止：

```bash
docker compose down          # 保留数据卷
docker compose down -v       # 同时删除数据库卷
```

### 方式二：本地 Node.js 运行

```bash
npm install
npm start
```

若 better-sqlite3 需要本地编译，请确保具备 Python 3、make、g++（Debian/Ubuntu：
`apt-get install -y python3 make g++`）。

浏览器同样打开 http://localhost:3000 。

运行几何算法测试：

```bash
npm test
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `DB_PATH` | `data/studio.db`（本地）/ `/data/studio.db`（Docker） | SQLite 数据库文件路径；目录不存在会自动创建，首次启动自动建表 |

Compose 中通过命名卷 `studio-data` 持久化 `/data`；改宿主机端口只需修改
`docker-compose.yml` 的端口映射（如 `"8080:3000"`）。

## 网页地址与端口

- 应用首页：`http://localhost:3000/`
- 端口：`3000`（可用 `PORT` 环境变量或 compose 端口映射更改）

## HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/designs` | 图纸列表 |
| POST | `/api/designs` | 新建图纸 `{name,width,height}`（宽高正整数毫米） |
| GET | `/api/designs/:id` | 草稿完整汇总（片/面积/缺口/铅条清单） |
| POST | `/api/designs/:id/pieces` | 新增拼片 `{color,polygon:[[x,y],...]}` |
| PUT | `/api/designs/:id/pieces/:pieceId` | 编辑拼片（改色/改顶点） |
| DELETE | `/api/designs/:id/pieces/:pieceId` | 删除拼片（仅草稿） |
| POST | `/api/designs/:id/publish` | 发布（未完整覆盖返回 422 + 缺口数据） |
| GET | `/api/designs/:id/publications` | 发布版列表 |
| GET | `/api/designs/:id/publications/:version` | 查阅指定发布版（不可变快照） |
| GET | `/api/designs/:id/publications/diff?fromVersion=1&toVersion=2` | 两版铅条核对（版本号；自动按版本号定较早/较晚，只读） |
| POST | `/api/publications/diff` | 两版铅条核对 `{publicationIdA,publicationIdB}`（非同图纸返回 400） |
| GET | `/api/materials` | 铅条原材规格与库存（含已预留/可用根数） |
| POST | `/api/materials` | 登记原材 `{name,length,stock}`（定尺正数 mm、库存非负整数） |
| GET | `/api/materials/:id` | 单个原材规格 |
| PATCH | `/api/materials/:id` | 改名称/库存根数 `{name?,stock?}`（定尺不可改；库存不得低于已预留） |
| POST | `/api/plans/preview` | 排产预览 `{publicationId,materialId,copies,kerf}`（不落库、不占库存） |
| POST | `/api/plans` | 建草稿计划（同上，可带 `name`） |
| GET | `/api/plans` | 计划列表（含状态/需用/缺口） |
| GET | `/api/plans/:id` | 计划详情（逐根切段、余料、绑定版本） |
| PUT | `/api/plans/:id` | 修改草稿（重选版本/件数/原材/刀损并重算） |
| POST | `/api/plans/:id/confirm` | 确认并原子预留；缺口返回 409 |
| POST | `/api/plans/:id/cancel` | 取消并释放预留（幂等） |
| DELETE | `/api/plans/:id` | 删除草稿/已取消计划（已确认须先取消） |

校验失败统一返回：

```json
{ "ok": false, "error": "原因", "category": "invalid|out_of_frame|overlap|not_covered",
  "at": [x, y], "gaps": [ { "polygon": [[x,y],...], "area": 1234.5 } ] }
```

## 使用流程

1. 左侧“新建图纸”，输入名称与窗框宽高（正整数毫米）。
2. 选择颜色，在画布上依次点击顶点绘制多边形（可自动吸附），双击完成；或在文本框逐行输入 `x,y` 后点“闭合多边形”。
3. 若被拒绝，画布会用红色 ✕ 标出问题位置，顶部红条说明原因与坐标。
4. 重复绘制直到覆盖状态变为“✓ 完整覆盖，无空隙”；绘制过程中缺口实时以红色斜纹显示。
5. 点击“发布图纸”，得到新版本；切到“已发布图纸”标签，选择版本查阅图纸、面积明细与铅条下料清单。
6. 发布后仍可继续编辑草稿（产生新版本），旧版本内容保持不变。
7. 切到“版本核对”标签：选择图纸与较早/较晚两个发布版 → “核对铅条下料变化”：画布与表格展示沿用（蓝实线）、取消（红虚线）、新增（绿实线）每一段的位置与长度，以及内部公共边、四根外框与总计三类合计。
8. 切到“铅条生产”标签：登记原材定尺与库存根数 → 选发布版本/件数/原材/每刀损耗 → “排产预览”查看逐根切段与余料 → “存为草稿计划” → 库存足够时“确认计划”原子预留；需要退料时“取消计划”释放预留。

## 铅条生产排产规则

- **长度单位**：所有长度（定尺、切段、刀损、余料）内部都以 **0.01 mm 的整数倍**精确运算，接口接受至多两位小数的毫米数；超过精度（如 `6000.005`）直接拒绝。
- **切段来源**：仅来自所选发布版本 `snapshot.leadList` 的 `internal`（内部公共边）与 `frameBars`（四根外框），按 `件数` 逐件复制，段不可拼接、不可跨件合并。
- **装箱**：切段先按长度降序、同长按清单顺序排序，再依次放入第一根剩余容量足够的原材；每段占位 = 成品长度 + 一刀损耗。某段 `成品 + 刀损 > 定尺` 时整单拒绝（返回 422 与该段信息）。
- **库存口径**：`available = stock − 所有已确认计划的 requiredBars 之和`。预览与草稿都不占库存；只有确认才预留。
- **并发**：确认使用 SQLite `BEGIN IMMEDIATE` 写事务，读取库存→核对缺口→置为 confirmed 在同一事务内完成，并发确认最多售出实际库存。

## 两版铅条核对规则

- **比较对象**：同一图纸的两个已发布版本（只读快照）。较早版 / 较晚版按版本号自动确定，`fromVersion` 与 `toVersion` 填反也会归一，不会把“沿用”错算成“取消+新增”。
- **分类口径（纯几何）**：把两版每根铅条放到同一根**无向直线**上，以沿直线的参数区间表示其空间覆盖：
  - 两版区间重叠的原子段 = **沿用（kept）**；
  - 仅较早版覆盖 = **取消（removed）**；仅较晚版覆盖 = **新增（added）**；
  - 部分重叠时以双方端点为界**拆分**为沿用/取消/新增三段。
- **不产生虚假差异的归一**：直线与方向无向归一（端点反向、清单顺序无关）；同一版同一直线上相接的区间先合并，因此 **T 接处“一侧整边、另一侧数段”** 等纯分段变化相互抵消；同一直线上两段不连续时中间空隙保留，不会被错误合并。
- **比较范围**：内部公共边（按几何直线自动分组）与四根外框（上/下/左/右分别核对；外框由窗框固定，同图纸两版通常四框全部沿用）。
- **精度**：直线分组与区间运算在“放大 100 倍”的整数坐标上精确完成（端点均为整数毫米）；段长为欧氏长度，**各类合计先对各段原始长度求和，再四舍五入到 0.01 mm**（斜线段可能出现 3 段各 1.41 mm、合计 4.24 mm 而非 4.23 mm 的情形，属预期）。
- **报错**：版本不存在返回 404；两个发布版不属于同一图纸（含窗框尺寸不一致）返回 400/422；接口不写数据库，**发布快照、生产计划、库存根数都不受影响**。

### 两版核对调用示例（curl）

```bash
# 方式一（GET，版本号）：核对 1 号图纸 v1 → v2
curl -s 'localhost:3000/api/designs/1/publications/diff?fromVersion=1&toVersion=2'
# -> { ok:true, meta:{ earlier:{version:1}, later:{version:2}, width,height },
#      diff:{ internal:{ kept:[{from,to,length}], removed:[...], added:[...], counts, totals },
#              frame:{"上框":{kept,removed,added,counts,totals}, ...}, frameOrder,
#              frameTotals, frameCounts, totals, counts } }

# 填反版本号也会自动归位（earlier 恒为较早版）
curl -s 'localhost:3000/api/designs/1/publications/diff?fromVersion=2&toVersion=1'

# 方式二（POST，发布版 id）
curl -s localhost:3000/api/publications/diff -H 'Content-Type: application/json' \
  -d '{"publicationIdA":1,"publicationIdB":2}'

# 版本不存在
curl -s 'localhost:3000/api/designs/1/publications/diff?fromVersion=1&toVersion=99'
# -> 404 {"ok":false,"error":"发布版 v99 不存在"}

# 两个发布版不属于同一图纸
curl -s localhost:3000/api/publications/diff -H 'Content-Type: application/json' \
  -d '{"publicationIdA":1,"publicationIdB":8}'
# -> 400 {"ok":false,"error":"两个发布版不属于同一图纸，不能核对铅条",
#         "designIdA":1,"designIdB":3}
```

响应中 `diff.totals` 为“内部公共边 + 四根外框”的总合计，`diff.internal.totals`、
`diff.frameTotals` 为分项合计；每个合计都含 `kept/removed/added` 三个长度（mm，
两位小数），`counts` 为对应段数。

### HTTP 调用示例（curl）

```bash
# 1) 登记原材：定尺 6000.00 mm、库存 10 根
curl -s localhost:3000/api/materials -H 'Content-Type: application/json' \
  -d '{"name":"6m 通用铅条","length":6000,"stock":10}'
# -> {"ok":true,"material":{"id":1,"name":"6m 通用铅条","length":6000,"stock":10,"reserved":0,"available":10,...}}

# 2) 查可用库存（reserved=已确认计划预留，available=还可用于新计划）
curl -s localhost:3000/api/materials

# 3) 排产预览（publicationId 取自发布接口返回的 id；不落库、不占库存）
curl -s localhost:3000/api/plans/preview -H 'Content-Type: application/json' \
  -d '{"publicationId":1,"materialId":1,"copies":3,"kerf":0.5}'
# -> preview.layout.bars[]：每根原材的 cuts（件次/切段名/成品长/刀损）、remainder 余料；
#    requiredBars 需用根数、availableBars 可用、shortage 缺口、feasible 是否可确认

# 4) 建草稿计划
curl -s localhost:3000/api/plans -H 'Content-Type: application/json' \
  -d '{"name":"三联窗订单","publicationId":1,"materialId":1,"copies":3,"kerf":0.5}'

# 5) 确认（库存足够才成功；缺口返回 409 + shortage）
curl -s -X POST localhost:3000/api/plans/1/confirm
# 6) 取消（释放预留；重复取消返回 409 且不再次改库存）
curl -s -X POST localhost:3000/api/plans/1/cancel
# 7) 查全部计划与可用库存
curl -s localhost:3000/api/plans
curl -s localhost:3000/api/materials
```

非法输入示例（均返回 400，库存不变）：定尺 `0`/负数、库存 `-1`、件数 `0`/`1.5`、刀损 `-0.01`、长度精度超过 0.01 mm。

## 目录结构

```
Dockerfile               容器镜像（含 better-sqlite3 编译环境）
docker-compose.yml       一键启动 + 数据卷持久化
src/
  server.js              Express 入口与 API（图纸/发布/两版核对/原材/生产计划）
  db.js                  SQLite 初始化与数据访问（含原子预留事务）
  geometry.js            精确几何校验、覆盖/缺口分析、铅条合并
  leaddiff.js            两版铅条核对（整数直线分组、区间沿用/取消/新增、拆分）
  cutting.js             铅条切段排产（0.01mm 整数运算、FFD、刀损）
public/
  index.html / style.css / app.js   单页前端（Canvas 编辑器/发布视图/版本核对/铅条生产）
test/
  geometry.test.js       几何算法测试（node --test）
  leaddiff.test.js       两版核对：反向/顺序/T接归一、部分重叠拆分、斜向合计舍入、非同图纸报错
  cutting.test.js        切段解析与 FFD 排产测试
  plans.api.test.js      生产计划端到端测试（含并发不超卖、快照绑定）
  diff.api.test.js       两版核对端到端测试（GET/POST、404/400、只读不改变快照/计划/库存）
```
