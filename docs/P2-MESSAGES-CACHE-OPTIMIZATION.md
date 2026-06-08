# P2：Messages 接口缓存化与稳定性优化方案

## 1. 背景

当前 `/api/v1/messages` 已完成 P0/P1 级别止血：

- 临时禁用 `keyword` 搜索；
- 临时禁用 `media=1` / `meiti=1` 媒体导出；
- 群聊 `senderUsername` / ChatLab sender 统一为空字符串；
- 增加请求级与分段耗时日志。

这些改动降低了接口卡死概率，但根因仍然存在：HTTP 请求链路仍可能直接触发微信 WCDB 原库读取，底层是 Electron Worker + koffi 原生同步调用。只要某次 WCDB 查询、深分页、游标读取或原生调用卡住，就可能造成 API 长时间无响应或队头阻塞。

P2 的目标是从架构上把 API 查询与微信原库读取解耦。

---

## 2. 核心目标

P2 将消息读取链路改造为：

```text
微信 WCDB 原库
  -> 后台同步任务
  -> WeSales 本地 SQLite 消息缓存库
  -> /api/v1/messages 查询缓存库
```

核心原则：

1. HTTP API 默认只读 WeSales 本地缓存库；
2. 微信 WCDB 原库只由后台同步任务读取；
3. API 请求不等待完整同步完成；
4. 深分页改用 cursor；
5. `keyword` 搜索后续只基于本地缓存恢复；
6. `media` 导出后续拆成独立异步任务，不回到消息列表接口。

---

## 3. 推荐新增模块

### 3.1 `electron/services/messageCacheService.ts`

职责：

- 初始化本地 SQLite 缓存库；
- 创建 `messages`、`message_sync_state`、`message_sync_jobs` 表；
- upsert 消息；
- 查询消息列表；
- 支持 cursor 分页；
- 查询/更新同步状态；
- 查询同步任务状态。

### 3.2 `electron/services/messageSyncService.ts`

职责：

- 从微信 WCDB 按 talker 增量同步到本地缓存；
- 后台队列化执行，同一时间只跑一个同步任务；
- 单任务限时、单批限量；
- 支持手动触发某个 talker 的同步；
- 记录同步任务耗时、写入条数、错误。

### 3.3 `electron/services/messageSearchService.ts`（后续阶段）

职责：

- 恢复 `keyword` 搜索；
- 初期可以使用 SQLite `LIKE`；
- 数据量增大后改为 SQLite FTS5；
- 搜索只查本地缓存库，不查微信 WCDB 原库。

---

## 4. 数据库位置

开发阶段建议放在项目数据目录：

```text
data/wesales.sqlite
```

打包或生产阶段可切换为 Electron userData：

```text
app.getPath('userData')/wesales.sqlite
```

无论放在哪里，SQLite 运行时数据文件必须加入 `.gitignore`，不得提交。

---

## 5. 表结构设计

### 5.1 `messages`

```sql
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  talker TEXT NOT NULL,
  local_id TEXT,
  msg_svr_id TEXT,
  sequence INTEGER,
  create_time INTEGER NOT NULL,
  is_sender INTEGER DEFAULT 0,
  sender_username TEXT DEFAULT '',
  type INTEGER,
  sub_type INTEGER,
  content TEXT,
  raw_content TEXT,
  display_content TEXT,
  status INTEGER,
  source_db TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(talker, msg_svr_id)
);
```

如果 `msg_svr_id` 缺失，需要用稳定字段组合生成 fallback key，但不能因为没有 server id 就无限重复写入。

### 5.2 `message_sync_state`

```sql
CREATE TABLE IF NOT EXISTS message_sync_state (
  talker TEXT PRIMARY KEY,
  last_create_time INTEGER DEFAULT 0,
  last_sequence INTEGER DEFAULT 0,
  last_msg_svr_id TEXT,
  last_sync_started_at INTEGER,
  last_sync_finished_at INTEGER,
  last_error TEXT,
  sync_status TEXT DEFAULT 'idle',
  updated_at INTEGER NOT NULL
);
```

### 5.3 `message_sync_jobs`

```sql
CREATE TABLE IF NOT EXISTS message_sync_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL UNIQUE,
  talker TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  scanned_count INTEGER DEFAULT 0,
  inserted_count INTEGER DEFAULT 0,
  updated_count INTEGER DEFAULT 0,
  error TEXT
);
```

### 5.4 推荐索引

```sql
CREATE INDEX IF NOT EXISTS idx_messages_talker_time
ON messages(talker, create_time DESC);

CREATE INDEX IF NOT EXISTS idx_messages_talker_sequence
ON messages(talker, sequence DESC);

CREATE INDEX IF NOT EXISTS idx_messages_time
ON messages(create_time DESC);

CREATE INDEX IF NOT EXISTS idx_messages_sender
ON messages(sender_username);

CREATE INDEX IF NOT EXISTS idx_messages_type
ON messages(type);
```

后续恢复全文搜索时增加：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
USING fts5(
  content,
  raw_content,
  talker UNINDEXED,
  msg_svr_id UNINDEXED,
  create_time UNINDEXED
);
```

---

## 6. API 设计

### 6.1 新增缓存查询接口

先新增并行接口，降低风险：

```http
GET /api/v1/messages-cache?talker=<talker>&limit=100&before=<cursor>
```

支持参数：

| 参数 | 说明 |
| --- | --- |
| `talker` | 会话 ID，必填 |
| `limit` | 返回条数，默认 100，最大建议 1000 |
| `before` | cursor，返回该时间之前的消息 |
| `start` | 可选开始时间 |
| `end` | 可选结束时间 |

响应示例：

```json
{
  "success": true,
  "source": "cache",
  "talker": "xxx",
  "count": 100,
  "hasMore": true,
  "nextCursor": 1717999999123,
  "sync": {
    "status": "idle",
    "lastSyncFinishedAt": 1718001234567,
    "cacheLagMs": 30000
  },
  "items": []
}
```

### 6.2 手动触发同步

```http
POST /api/v1/messages/sync?talker=<talker>
```

响应：

```json
{
  "success": true,
  "jobId": "msgsync_xxx",
  "status": "queued"
}
```

### 6.3 查询同步状态

```http
GET /api/v1/messages/sync/status?jobId=<jobId>
```

或：

```http
GET /api/v1/messages/sync/status?talker=<talker>
```

响应：

```json
{
  "success": true,
  "jobId": "msgsync_xxx",
  "talker": "xxx",
  "status": "running",
  "scannedCount": 1200,
  "insertedCount": 300,
  "costMs": 5000
}
```

---

## 7. 同步策略

### 7.1 启动同步

Electron 启动后：

1. 初始化缓存库；
2. 读取最近活跃会话；
3. 后台同步最近 N 个会话；
4. 不做启动时全量扫描。

建议初始限制：

```ts
const STARTUP_ACTIVE_TALKER_LIMIT = 20;
const STARTUP_PER_TALKER_LIMIT = 5000;
```

### 7.2 按需同步

当用户请求某个 talker 的缓存消息时：

1. API 先查本地缓存并快速返回；
2. 如果缓存为空或过旧，后台触发该 talker 同步；
3. 本次请求不等待完整同步完成；
4. 响应中通过 `sync` 字段告诉前端同步状态。

### 7.3 同步限流

建议：

```ts
const MAX_CONCURRENT_SYNC = 1;
const MAX_BATCH_SIZE = 500;
const MAX_SYNC_TIME_MS = 30_000;
```

同一时间只允许一个同步任务访问 WCDB Worker，避免后台同步反过来造成队头阻塞。

---

## 8. Worker 保护增强

虽然 P2 让 API 默认查缓存，但同步服务仍会访问 WCDB Worker，因此仍需补充保护：

1. `wcdbService.callWorker` 增加 timeout；
2. timeout 后清理 pending map；
3. 连续 timeout 后 terminate/restart Worker；
4. 增加 pending 队列长度、耗时、重启日志。

建议日志：

```text
[WcdbService] call start id=xxx method=xxx pending=3 timeout=30000
[WcdbService] call done id=xxx method=xxx cost=1234ms
[WcdbService] call timeout id=xxx method=xxx cost=30000ms
[WcdbService] worker restart reason=timeout pending=2
```

---

## 9. Keyword 搜索恢复路径

不在 P2 MVP 内恢复微信原库搜索。

后续恢复时：

1. 仅查本地缓存库；
2. 初期用 `LIKE`；
3. 数据量变大后切 FTS5；
4. API 响应增加 `source: "cache"` 与 `searchMode`。

---

## 10. Media 恢复路径

不再把 `media=1` 放回 `/api/v1/messages`。

后续拆成独立异步接口：

```http
POST /api/v1/media/export
GET /api/v1/media/export/status?jobId=<jobId>
GET /api/v1/media/file/<assetId>
```

消息列表接口只返回媒体元信息，不做文件 IO、解密或复制。

---

## 11. 建议实施顺序

### 阶段 1：缓存基础设施

- 新增 `messageCacheService.ts`；
- 初始化 SQLite 表与索引；
- 增加 upsert/query/sync state/job 方法；
- 不改变现有 `/api/v1/messages` 行为。

### 阶段 2：后台同步服务

- 新增 `messageSyncService.ts`；
- 支持按 talker 增量同步；
- 单任务限流与超时；
- 记录 job/state。

### 阶段 3：新增缓存查询接口

- 新增 `/api/v1/messages-cache`；
- 支持 `talker`、`limit`、`before`、`start`、`end`；
- 返回 `source`、`sync`、`nextCursor`。

### 阶段 4：灰度切换主接口

- `/api/v1/messages` 默认查缓存；
- 保留原 WCDB 直接查询作为 debug/fallback，但默认不启用；
- 完成前端兼容验证后再移除 fallback。

### 阶段 5：恢复 keyword

- 基于缓存库恢复；
- 先 LIKE，后 FTS5。

### 阶段 6：媒体异步化

- 媒体导出拆成独立 job；
- 消息列表不做媒体文件操作。

---

## 12. P2 MVP 范围

第一轮 Codex 实施建议只做低风险 MVP：

1. 新增本地 SQLite 消息缓存服务；
2. 新增后台同步服务骨架和 talker 手动同步能力；
3. 新增 `/api/v1/messages-cache`；
4. 新增 `/api/v1/messages/sync`；
5. 新增 `/api/v1/messages/sync/status`；
6. 保持现有 `/api/v1/messages` 不切换；
7. 不恢复 `keyword`；
8. 不恢复 `media=1`。

MVP 验证稳定后，再切换主接口。

---

## 13. 验收标准

P2 MVP 完成后至少满足：

- `npm run typecheck` 通过；
- `npm run build` 通过；
- `/api/v1/messages-cache` 不直接查询微信 WCDB 原库；
- `/api/v1/messages-cache` 支持 cursor 分页；
- `/api/v1/messages-cache` 返回同步状态；
- `/api/v1/messages/sync` 能返回 jobId，不阻塞等待同步完成；
- 同步任务有耗时、扫描数、写入数、错误日志；
- SQLite 运行时文件不进入 git；
- 现有 `/api/v1/messages` 行为不被破坏。
