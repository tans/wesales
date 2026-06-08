import { chatService, Message } from './chatService'
import { wcdbService } from './wcdbService'
import { sqliteMessageCacheService, MessageSyncJob } from './messageCacheService'

interface TriggerSyncOptions {
  limit?: number
  start?: number
  end?: number
}

interface ActiveSyncTask {
  jobId: string
  talker: string
  limit: number
  start: number
  end: number
}

class MessageSyncService {
  private running = false
  private queue: ActiveSyncTask[] = []
  private readonly defaultBatchLimit = 500
  private readonly maxBatchLimit = 500

  triggerSync(talker: string, options: TriggerSyncOptions = {}): { success: boolean; jobId: string; status: MessageSyncJob['status'] } {
    const normalizedTalker = String(talker || '').trim()
    if (!normalizedTalker) {
      throw new Error('Missing required parameter: talker')
    }

    const jobId = `msgsync_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const limit = this.normalizeLimit(options.limit)
    const task: ActiveSyncTask = {
      jobId,
      talker: normalizedTalker,
      limit,
      start: this.normalizeTimestamp(options.start),
      end: this.normalizeTimestamp(options.end)
    }

    sqliteMessageCacheService.createSyncJob(jobId, normalizedTalker, 'queued')
    this.queue.push(task)
    this.drainQueue().catch((error) => {
      console.error('[MessageSyncService] drainQueue error:', error)
    })

    return { success: true, jobId, status: 'queued' }
  }

  getJob(jobId: string): MessageSyncJob | null {
    return sqliteMessageCacheService.getSyncJob(jobId)
  }

  getTalkerStatus(talker: string): { state: ReturnType<typeof sqliteMessageCacheService.getSyncState>; latestJob: MessageSyncJob | null } {
    return {
      state: sqliteMessageCacheService.getSyncState(talker),
      latestJob: sqliteMessageCacheService.getLatestSyncJobForTalker(talker)
    }
  }

  private async drainQueue(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()
        if (!task) continue
        await this.runTask(task)
      }
    } finally {
      this.running = false
    }
  }

  private async runTask(task: ActiveSyncTask): Promise<void> {
    const startedAt = Date.now()
    let cursor: number | null = null
    let scanned = 0
    let inserted = 0
    let updated = 0
    let lastMessage: Message | null = null

    sqliteMessageCacheService.updateSyncJob(task.jobId, { status: 'running' })
    sqliteMessageCacheService.upsertSyncState(task.talker, {
      syncStatus: 'running',
      lastSyncStartedAt: startedAt,
      lastError: null
    })

    try {
      const cursorResult = await wcdbService.openMessageCursorLite(task.talker, task.limit, false, task.start, task.end)
      if (!cursorResult.success || !cursorResult.cursor) {
        throw new Error(cursorResult.error || '打开消息游标失败')
      }
      cursor = cursorResult.cursor

      const batchResult = await wcdbService.fetchMessageBatch(cursor)
      if (!batchResult.success) {
        throw new Error(batchResult.error || '读取消息批次失败')
      }

      const rows = Array.isArray(batchResult.rows) ? batchResult.rows : []
      scanned = rows.length
      const messages = chatService.mapRowsToMessagesLiteForApi(rows as Record<string, any>[])
      if (task.talker.endsWith('@chatroom')) {
        for (const message of messages) {
          message.senderUsername = ''
        }
      }

      const writeSummary = sqliteMessageCacheService.upsertMessages(task.talker, messages)
      inserted = writeSummary.inserted
      updated = writeSummary.updated
      lastMessage = this.pickNewestMessage(messages)

      const finishedAt = Date.now()
      sqliteMessageCacheService.updateSyncJob(task.jobId, {
        status: 'completed',
        finishedAt,
        scannedCount: scanned,
        insertedCount: inserted,
        updatedCount: updated,
        error: null
      })
      sqliteMessageCacheService.upsertSyncState(task.talker, {
        syncStatus: 'idle',
        lastCreateTime: lastMessage?.createTime || sqliteMessageCacheService.getSyncState(task.talker)?.lastCreateTime || 0,
        lastSequence: lastMessage?.sortSeq || sqliteMessageCacheService.getSyncState(task.talker)?.lastSequence || 0,
        lastMsgSvrId: this.getMessageServerId(lastMessage) || sqliteMessageCacheService.getSyncState(task.talker)?.lastMsgSvrId || null,
        lastSyncFinishedAt: finishedAt,
        lastError: null
      })
      console.log(`[MessageSyncService] job completed jobId=${task.jobId} talker=${task.talker} scanned=${scanned} inserted=${inserted} updated=${updated} cost=${finishedAt - startedAt}ms`)
    } catch (error) {
      const finishedAt = Date.now()
      const errorMessage = error instanceof Error ? error.message : String(error)
      sqliteMessageCacheService.updateSyncJob(task.jobId, {
        status: 'failed',
        finishedAt,
        scannedCount: scanned,
        insertedCount: inserted,
        updatedCount: updated,
        error: errorMessage
      })
      sqliteMessageCacheService.upsertSyncState(task.talker, {
        syncStatus: 'failed',
        lastSyncFinishedAt: finishedAt,
        lastError: errorMessage
      })
      console.error(`[MessageSyncService] job failed jobId=${task.jobId} talker=${task.talker} scanned=${scanned} inserted=${inserted} updated=${updated} cost=${finishedAt - startedAt}ms error=${errorMessage}`)
    } finally {
      if (cursor !== null) {
        await wcdbService.closeMessageCursor(cursor).catch((error) => {
          console.warn(`[MessageSyncService] close cursor failed jobId=${task.jobId} talker=${task.talker}:`, error)
        })
      }
    }
  }

  private normalizeLimit(value: unknown): number {
    const parsed = parseInt(String(value ?? ''), 10)
    if (!Number.isFinite(parsed) || parsed <= 0) return this.defaultBatchLimit
    return Math.min(Math.max(parsed, 1), this.maxBatchLimit)
  }

  private normalizeTimestamp(value: unknown): number {
    const parsed = parseInt(String(value ?? ''), 10)
    if (!Number.isFinite(parsed) || parsed <= 0) return 0
    return parsed > 10000000000 ? Math.floor(parsed / 1000) : parsed
  }

  private pickNewestMessage(messages: Message[]): Message | null {
    let newest: Message | null = null
    for (const message of messages) {
      if (!newest || message.createTime > newest.createTime || (message.createTime === newest.createTime && message.sortSeq > newest.sortSeq)) {
        newest = message
      }
    }
    return newest
  }

  private getMessageServerId(message: Message | null): string {
    if (!message) return ''
    const raw = this.normalizeUnsignedIntToken(message.serverIdRaw)
    if (raw && raw !== '0') return raw
    const fallback = this.normalizeUnsignedIntToken(message.serverId)
    return fallback && fallback !== '0' ? fallback : ''
  }

  private normalizeUnsignedIntToken(value: unknown): string {
    if (value === null || value === undefined) return ''
    const text = String(value).trim()
    if (!text) return ''
    if (/^\d+$/.test(text)) return text.replace(/^0+(?=\d)/, '')
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) return ''
    return String(Math.floor(numeric))
  }
}

export const messageSyncService = new MessageSyncService()
