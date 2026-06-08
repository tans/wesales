import { join, dirname } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { app } from 'electron'
import Database from 'better-sqlite3'
import { ConfigService } from './config'
import type { Message } from './chatService'

export interface SessionMessageCacheEntry {
  updatedAt: number
  messages: any[]
}

export class MessageCacheService {
  private readonly cacheFilePath: string
  private cache: Record<string, SessionMessageCacheEntry> = {}
  private readonly sessionLimit = 150
  private readonly maxSessionEntries = 48

  constructor(cacheBasePath?: string) {
    const basePath = cacheBasePath && cacheBasePath.trim().length > 0
      ? cacheBasePath
      : ConfigService.getInstance().getCacheBasePath()
    this.cacheFilePath = join(basePath, 'session-messages.json')
    this.ensureCacheDir()
    this.loadCache()
  }

  private ensureCacheDir() {
    const dir = dirname(this.cacheFilePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  private loadCache() {
    if (!existsSync(this.cacheFilePath)) return
    try {
      const raw = readFileSync(this.cacheFilePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        this.cache = parsed
        this.pruneSessionEntries()
      }
    } catch (error) {
      console.error('MessageCacheService: 载入缓存失败', error)
      this.cache = {}
    }
  }

  private pruneSessionEntries(): void {
    const entries = Object.entries(this.cache || {})
    if (entries.length <= this.maxSessionEntries) return

    entries.sort((left, right) => {
      const leftAt = Number(left[1]?.updatedAt || 0)
      const rightAt = Number(right[1]?.updatedAt || 0)
      return rightAt - leftAt
    })

    this.cache = Object.fromEntries(entries.slice(0, this.maxSessionEntries))
  }

  get(sessionId: string): SessionMessageCacheEntry | undefined {
    return this.cache[sessionId]
  }

  set(sessionId: string, messages: any[]): void {
    if (!sessionId) return
    const trimmed = messages.length > this.sessionLimit
      ? messages.slice(-this.sessionLimit)
      : messages.slice()
    this.cache[sessionId] = {
      updatedAt: Date.now(),
      messages: trimmed
    }
    this.pruneSessionEntries()
    this.persist()
  }

  private persist() {
    try {
      writeFileSync(this.cacheFilePath, JSON.stringify(this.cache), 'utf8')
    } catch (error) {
      console.error('MessageCacheService: 保存缓存失败', error)
    }
  }

  clear(): void {
    this.cache = {}
    try {
      rmSync(this.cacheFilePath, { force: true })
    } catch (error) {
      console.error('MessageCacheService: 清理缓存失败', error)
    }
  }
}

export type MessageSyncJobStatus = 'queued' | 'running' | 'completed' | 'failed'
export type MessageSyncStateStatus = 'idle' | 'running' | 'failed'

export interface CachedMessageRecord {
  id?: number
  talker: string
  localId: string
  msgSvrId: string
  sequence: number
  createTime: number
  isSender: number
  senderUsername: string
  type: number
  subType: number
  content: string
  rawContent: string
  displayContent: string
  status: number
  sourceDb: string
}

export interface CachedMessageQueryOptions {
  talker: string
  limit: number
  before?: number
  start?: number
  end?: number
}

export interface CachedMessageQueryResult {
  items: CachedMessageRecord[]
  hasMore: boolean
  nextCursor?: number
}

export interface MessageSyncState {
  talker: string
  lastCreateTime: number
  lastSequence: number
  lastMsgSvrId: string | null
  lastSyncStartedAt: number | null
  lastSyncFinishedAt: number | null
  lastError: string | null
  syncStatus: MessageSyncStateStatus
  updatedAt: number
}

export interface MessageSyncJob {
  id?: number
  jobId: string
  talker: string
  status: MessageSyncJobStatus
  startedAt: number
  finishedAt: number | null
  scannedCount: number
  insertedCount: number
  updatedCount: number
  error: string | null
}

interface UpsertSummary {
  inserted: number
  updated: number
}

type SqliteMessageRow = {
  id: number
  talker: string
  local_id: string | null
  msg_svr_id: string | null
  sequence: number | null
  create_time: number
  is_sender: number | null
  sender_username: string | null
  type: number | null
  sub_type: number | null
  content: string | null
  raw_content: string | null
  display_content: string | null
  status: number | null
  source_db: string | null
}

type SqliteSyncStateRow = {
  talker: string
  last_create_time: number | null
  last_sequence: number | null
  last_msg_svr_id: string | null
  last_sync_started_at: number | null
  last_sync_finished_at: number | null
  last_error: string | null
  sync_status: MessageSyncStateStatus | null
  updated_at: number
}

type SqliteSyncJobRow = {
  id: number
  job_id: string
  talker: string | null
  status: MessageSyncJobStatus
  started_at: number
  finished_at: number | null
  scanned_count: number | null
  inserted_count: number | null
  updated_count: number | null
  error: string | null
}

export class SqliteMessageCacheService {
  private db: Database.Database | null = null
  private readonly dbPath: string

  constructor(dbPath?: string) {
    const defaultPath = this.resolveDefaultDbPath()
    this.dbPath = dbPath && dbPath.trim().length > 0 ? dbPath : defaultPath
  }

  getDatabasePath(): string {
    return this.dbPath
  }

  init(): void {
    if (this.db) return
    mkdirSync(dirname(this.dbPath), { recursive: true })
    const db = new Database(this.dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
    db.exec(`
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

      CREATE INDEX IF NOT EXISTS idx_messages_talker_time ON messages(talker, create_time DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_talker_sequence ON messages(talker, sequence DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(create_time DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_username);
      CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
      CREATE INDEX IF NOT EXISTS idx_message_sync_jobs_talker ON message_sync_jobs(talker, started_at DESC);
    `)
    this.db = db
  }

  close(): void {
    if (!this.db) return
    this.db.close()
    this.db = null
  }

  upsertMessages(talker: string, messages: Message[]): UpsertSummary {
    if (messages.length === 0) return { inserted: 0, updated: 0 }
    const db = this.getDb()
    const now = Date.now()
    let inserted = 0
    let updated = 0

    const findExisting = db.prepare('SELECT id FROM messages WHERE talker = ? AND msg_svr_id = ? LIMIT 1')
    const upsert = db.prepare(`
      INSERT INTO messages (
        talker, local_id, msg_svr_id, sequence, create_time, is_sender,
        sender_username, type, sub_type, content, raw_content, display_content,
        status, source_db, created_at, updated_at
      ) VALUES (
        @talker, @localId, @msgSvrId, @sequence, @createTime, @isSender,
        @senderUsername, @type, @subType, @content, @rawContent, @displayContent,
        @status, @sourceDb, @createdAt, @updatedAt
      )
      ON CONFLICT(talker, msg_svr_id) DO UPDATE SET
        local_id = excluded.local_id,
        sequence = excluded.sequence,
        create_time = excluded.create_time,
        is_sender = excluded.is_sender,
        sender_username = excluded.sender_username,
        type = excluded.type,
        sub_type = excluded.sub_type,
        content = excluded.content,
        raw_content = excluded.raw_content,
        display_content = excluded.display_content,
        status = excluded.status,
        source_db = excluded.source_db,
        updated_at = excluded.updated_at
    `)

    const run = db.transaction((items: Message[]) => {
      for (const msg of items) {
        const record = this.messageToRecord(talker, msg, now)
        const existed = findExisting.get(record.talker, record.msgSvrId) as { id: number } | undefined
        upsert.run(record)
        if (existed) updated += 1
        else inserted += 1
      }
    })
    run(messages)
    return { inserted, updated }
  }

  queryMessages(options: CachedMessageQueryOptions): CachedMessageQueryResult {
    const limit = Math.min(Math.max(Math.floor(options.limit || 100), 1), 1000)
    const params: Record<string, number | string> = { talker: options.talker, limit: limit + 1 }
    const where = ['talker = @talker']
    if (Number.isFinite(options.before || NaN) && (options.before || 0) > 0) {
      where.push('create_time < @before')
      params.before = Math.floor(options.before || 0)
    }
    if (Number.isFinite(options.start || NaN) && (options.start || 0) > 0) {
      where.push('create_time >= @start')
      params.start = Math.floor(options.start || 0)
    }
    if (Number.isFinite(options.end || NaN) && (options.end || 0) > 0) {
      where.push('create_time <= @end')
      params.end = Math.floor(options.end || 0)
    }

    const rows = this.getDb()
      .prepare(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY create_time DESC, sequence DESC, id DESC LIMIT @limit`)
      .all(params) as SqliteMessageRow[]
    const hasMore = rows.length > limit
    const visibleRows = hasMore ? rows.slice(0, limit) : rows
    const last = visibleRows[visibleRows.length - 1]
    return {
      items: visibleRows.map((row) => this.rowToCachedMessage(row)),
      hasMore,
      nextCursor: hasMore && last ? last.create_time : undefined
    }
  }

  getSyncState(talker: string): MessageSyncState | null {
    const row = this.getDb()
      .prepare('SELECT * FROM message_sync_state WHERE talker = ? LIMIT 1')
      .get(talker) as SqliteSyncStateRow | undefined
    return row ? this.rowToSyncState(row) : null
  }

  upsertSyncState(talker: string, patch: Partial<Omit<MessageSyncState, 'talker' | 'updatedAt'>>): MessageSyncState {
    const existing = this.getSyncState(talker)
    const now = Date.now()
    const next: MessageSyncState = {
      talker,
      lastCreateTime: patch.lastCreateTime ?? existing?.lastCreateTime ?? 0,
      lastSequence: patch.lastSequence ?? existing?.lastSequence ?? 0,
      lastMsgSvrId: patch.lastMsgSvrId ?? existing?.lastMsgSvrId ?? null,
      lastSyncStartedAt: patch.lastSyncStartedAt ?? existing?.lastSyncStartedAt ?? null,
      lastSyncFinishedAt: patch.lastSyncFinishedAt ?? existing?.lastSyncFinishedAt ?? null,
      lastError: patch.lastError === undefined ? existing?.lastError ?? null : patch.lastError,
      syncStatus: patch.syncStatus ?? existing?.syncStatus ?? 'idle',
      updatedAt: now
    }
    this.getDb().prepare(`
      INSERT INTO message_sync_state (
        talker, last_create_time, last_sequence, last_msg_svr_id,
        last_sync_started_at, last_sync_finished_at, last_error, sync_status, updated_at
      ) VALUES (
        @talker, @lastCreateTime, @lastSequence, @lastMsgSvrId,
        @lastSyncStartedAt, @lastSyncFinishedAt, @lastError, @syncStatus, @updatedAt
      )
      ON CONFLICT(talker) DO UPDATE SET
        last_create_time = excluded.last_create_time,
        last_sequence = excluded.last_sequence,
        last_msg_svr_id = excluded.last_msg_svr_id,
        last_sync_started_at = excluded.last_sync_started_at,
        last_sync_finished_at = excluded.last_sync_finished_at,
        last_error = excluded.last_error,
        sync_status = excluded.sync_status,
        updated_at = excluded.updated_at
    `).run(next)
    return next
  }

  createSyncJob(jobId: string, talker: string, status: MessageSyncJobStatus = 'queued'): MessageSyncJob {
    const job: MessageSyncJob = {
      jobId,
      talker,
      status,
      startedAt: Date.now(),
      finishedAt: null,
      scannedCount: 0,
      insertedCount: 0,
      updatedCount: 0,
      error: null
    }
    this.getDb().prepare(`
      INSERT INTO message_sync_jobs (
        job_id, talker, status, started_at, finished_at,
        scanned_count, inserted_count, updated_count, error
      ) VALUES (
        @jobId, @talker, @status, @startedAt, @finishedAt,
        @scannedCount, @insertedCount, @updatedCount, @error
      )
    `).run(job)
    return job
  }

  updateSyncJob(jobId: string, patch: Partial<Omit<MessageSyncJob, 'jobId' | 'talker' | 'startedAt'>>): MessageSyncJob | null {
    const existing = this.getSyncJob(jobId)
    if (!existing) return null
    const next: MessageSyncJob = { ...existing, ...patch }
    this.getDb().prepare(`
      UPDATE message_sync_jobs SET
        status = @status,
        finished_at = @finishedAt,
        scanned_count = @scannedCount,
        inserted_count = @insertedCount,
        updated_count = @updatedCount,
        error = @error
      WHERE job_id = @jobId
    `).run(next)
    return next
  }

  getSyncJob(jobId: string): MessageSyncJob | null {
    const row = this.getDb()
      .prepare('SELECT * FROM message_sync_jobs WHERE job_id = ? LIMIT 1')
      .get(jobId) as SqliteSyncJobRow | undefined
    return row ? this.rowToSyncJob(row) : null
  }

  getLatestSyncJobForTalker(talker: string): MessageSyncJob | null {
    const row = this.getDb()
      .prepare('SELECT * FROM message_sync_jobs WHERE talker = ? ORDER BY started_at DESC, id DESC LIMIT 1')
      .get(talker) as SqliteSyncJobRow | undefined
    return row ? this.rowToSyncJob(row) : null
  }

  private getDb(): Database.Database {
    this.init()
    if (!this.db) throw new Error('message cache database unavailable')
    return this.db
  }

  private resolveDefaultDbPath(): string {
    try {
      if (app?.isReady?.()) {
        return join(app.getPath('userData'), 'wesales.sqlite')
      }
    } catch {}
    return join(process.cwd(), 'data', 'wesales.sqlite')
  }

  private messageToRecord(talker: string, msg: Message, now: number): CachedMessageRecord & { createdAt: number; updatedAt: number } {
    const serverId = this.normalizeUnsignedIntToken(msg.serverIdRaw) || this.normalizeUnsignedIntToken(msg.serverId)
    const localId = this.normalizeText(msg.localId)
    const sequence = this.normalizeInt(msg.sortSeq, msg.createTime > 0 ? msg.createTime * 1000 : 0)
    const createTime = this.normalizeInt(msg.createTime, 0)
    const rawContent = String(msg.rawContent ?? msg.content ?? '')
    const content = String(msg.content ?? rawContent)
    const displayContent = String(msg.parsedContent || content || rawContent || '')
    const senderUsername = talker.endsWith('@chatroom') ? '' : String(msg.senderUsername || '')
    const sourceDb = String(msg._db_path || '')
    const fallbackKey = [
      'fallback',
      localId || '0',
      createTime || 0,
      sequence || 0,
      msg.localType || 0,
      this.hashText(`${content}|${rawContent}|${sourceDb}`)
    ].join(':')

    return {
      talker,
      localId,
      // WCDB rows can lack a stable server id. This fallback is conservative and deterministic
      // across sync runs so missing msg_svr_id rows do not duplicate endlessly.
      msgSvrId: serverId || fallbackKey,
      sequence,
      createTime,
      isSender: msg.isSend === 1 ? 1 : 0,
      senderUsername,
      type: this.normalizeInt(msg.localType, 0),
      subType: 0,
      content,
      rawContent,
      displayContent,
      status: 0,
      sourceDb,
      createdAt: now,
      updatedAt: now
    }
  }

  private rowToCachedMessage(row: SqliteMessageRow): CachedMessageRecord {
    return {
      id: row.id,
      talker: row.talker,
      localId: row.local_id || '',
      msgSvrId: row.msg_svr_id || '',
      sequence: row.sequence || 0,
      createTime: row.create_time || 0,
      isSender: row.is_sender || 0,
      senderUsername: row.sender_username || '',
      type: row.type || 0,
      subType: row.sub_type || 0,
      content: row.content || '',
      rawContent: row.raw_content || '',
      displayContent: row.display_content || '',
      status: row.status || 0,
      sourceDb: row.source_db || ''
    }
  }

  private rowToSyncState(row: SqliteSyncStateRow): MessageSyncState {
    return {
      talker: row.talker,
      lastCreateTime: row.last_create_time || 0,
      lastSequence: row.last_sequence || 0,
      lastMsgSvrId: row.last_msg_svr_id || null,
      lastSyncStartedAt: row.last_sync_started_at || null,
      lastSyncFinishedAt: row.last_sync_finished_at || null,
      lastError: row.last_error || null,
      syncStatus: row.sync_status || 'idle',
      updatedAt: row.updated_at
    }
  }

  private rowToSyncJob(row: SqliteSyncJobRow): MessageSyncJob {
    return {
      id: row.id,
      jobId: row.job_id,
      talker: row.talker || '',
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at || null,
      scannedCount: row.scanned_count || 0,
      insertedCount: row.inserted_count || 0,
      updatedCount: row.updated_count || 0,
      error: row.error || null
    }
  }

  private normalizeText(value: unknown): string {
    if (value === null || value === undefined) return ''
    return String(value).trim()
  }

  private normalizeInt(value: unknown, fallback: number): number {
    const parsed = parseInt(String(value ?? ''), 10)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  private normalizeUnsignedIntToken(value: unknown): string {
    const text = this.normalizeText(value)
    if (!text) return ''
    if (/^\d+$/.test(text)) return text.replace(/^0+(?=\d)/, '')
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) return ''
    return String(Math.floor(numeric))
  }

  private hashText(value: string): string {
    let hash = 2166136261
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(16)
  }
}

export const sqliteMessageCacheService = new SqliteMessageCacheService()
