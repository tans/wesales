#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const DEFAULT_BASE_URL = 'http://127.0.0.1:5031'

function printUsage() {
  console.log(`Usage:
  node scripts/test-http-api.mjs [options]

Options:
  --base-url <url>      API base URL. Default: ${DEFAULT_BASE_URL}
  --host <host>         Host shortcut. Default: 127.0.0.1
  --port <port>         Port shortcut. Default: 5031
  --token <token>       Access token. Or set WEFLOW_API_TOKEN / API_TOKEN.
  --config-cwd <dir>    Read WeFlow-config.json and decrypt httpApiToken when needed.
                        Or set WEFLOW_CONFIG_CWD / WEFLOW_API_CONFIG_CWD.
  --electron <path>     Electron binary for decrypting safe: token. Default: node_modules/.bin/electron.
  --talker <id>         Session ID for /api/v1/messages. If omitted, uses the first session.
  --sessions-limit <n>  Session list limit. Default: 10
  --messages-limit <n>  Message list limit. Default: 5
  --offset <n>          Message offset. Default: 0
  --keyword <text>      Optional message keyword filter.
  --start <value>       Optional message start time, YYYYMMDD or Unix timestamp.
  --end <value>         Optional message end time, YYYYMMDD or Unix timestamp.
  --format <value>      json or chatlab for /api/v1/messages. Default: json
  --method <value>      get or post for sessions/messages. Default: get
  --raw                 Print full JSON responses.
  --help                Show this help.

Examples:
  WEFLOW_API_TOKEN=xxx npm run api:test
  npm run api:test -- --token xxx --talker wxid_xxx --messages-limit 20
  node scripts/test-http-api.mjs --host 127.0.0.1 --port 5031 --token xxx
`)
}

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.WEFLOW_API_BASE_URL || '',
    host: process.env.WEFLOW_API_HOST || '127.0.0.1',
    port: process.env.WEFLOW_API_PORT || '5031',
    token: process.env.WEFLOW_API_TOKEN || process.env.API_TOKEN || '',
    configCwd: process.env.WEFLOW_API_CONFIG_CWD || process.env.WEFLOW_CONFIG_CWD || '',
    electron: process.env.ELECTRON_PATH || './node_modules/.bin/electron',
    talker: process.env.WEFLOW_API_TALKER || '',
    sessionsLimit: process.env.WEFLOW_API_SESSIONS_LIMIT || '10',
    messagesLimit: process.env.WEFLOW_API_MESSAGES_LIMIT || '5',
    offset: process.env.WEFLOW_API_OFFSET || '0',
    keyword: process.env.WEFLOW_API_KEYWORD || '',
    start: process.env.WEFLOW_API_START || '',
    end: process.env.WEFLOW_API_END || '',
    format: process.env.WEFLOW_API_FORMAT || 'json',
    method: process.env.WEFLOW_API_METHOD || 'get',
    raw: false
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) {
        throw new Error(`Missing value for ${arg}`)
      }
      return argv[i]
    }

    switch (arg) {
      case '--base-url':
        args.baseUrl = next()
        break
      case '--host':
        args.host = next()
        break
      case '--port':
        args.port = next()
        break
      case '--token':
        args.token = next()
        break
      case '--config-cwd':
        args.configCwd = next()
        break
      case '--electron':
        args.electron = next()
        break
      case '--talker':
        args.talker = next()
        break
      case '--sessions-limit':
        args.sessionsLimit = next()
        break
      case '--messages-limit':
        args.messagesLimit = next()
        break
      case '--offset':
        args.offset = next()
        break
      case '--keyword':
        args.keyword = next()
        break
      case '--start':
        args.start = next()
        break
      case '--end':
        args.end = next()
        break
      case '--format':
        args.format = next()
        break
      case '--method':
        args.method = next()
        break
      case '--raw':
        args.raw = true
        break
      case '--help':
      case '-h':
        args.help = true
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }

  args.baseUrl = normalizeBaseUrl(args.baseUrl || `http://${args.host}:${args.port}`)
  args.sessionsLimit = normalizeInt(args.sessionsLimit, 10, 1, 10000)
  args.messagesLimit = normalizeInt(args.messagesLimit, 5, 1, 10000)
  args.offset = normalizeInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER)
  args.method = String(args.method || 'get').toLowerCase()
  args.format = String(args.format || 'json').toLowerCase()

  if (!['get', 'post'].includes(args.method)) {
    throw new Error('--method must be get or post')
  }
  if (!['json', 'chatlab'].includes(args.format)) {
    throw new Error('--format must be json or chatlab')
  }

  return args
}

async function readTokenFromConfig(configCwd, electronPath) {
  if (!configCwd) return ''
  const configPath = join(configCwd, 'WeFlow-config.json')
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`)
  }

  const config = JSON.parse(await readFile(configPath, 'utf8'))
  const rawToken = String(config.httpApiToken || '').trim()
  if (!rawToken) return ''
  if (!rawToken.startsWith('safe:')) return rawToken

  return decryptSafeStorageValue(rawToken, electronPath)
}

async function decryptSafeStorageValue(value, electronPath) {
  const tempDir = await mkdtemp(join(tmpdir(), 'weflow-api-token-'))
  const mainPath = join(tempDir, 'main.js')
  const packagePath = join(tempDir, 'package.json')
  const script = `
const { app, safeStorage } = require('electron')
app.whenReady().then(() => {
  try {
    const raw = ${JSON.stringify(value)}
    if (!safeStorage.isEncryptionAvailable()) {
      console.error('safeStorage encryption is not available in this environment')
      app.exit(2)
      return
    }
    const token = safeStorage.decryptString(Buffer.from(raw.slice(5), 'base64'))
    process.stdout.write(token)
    app.exit(0)
  } catch (error) {
    console.error(error && error.message ? error.message : String(error))
    app.exit(1)
  }
})
`

  try {
    await writeFile(packagePath, JSON.stringify({ main: 'main.js' }), 'utf8')
    await writeFile(mainPath, script, 'utf8')
    return await runElectronForOutput(electronPath, tempDir)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

function runElectronForOutput(electronPath, appPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, ['--no-sandbox', appPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim())
      } else {
        reject(new Error(`Electron token decrypt failed with code ${code}: ${stderr.trim() || stdout.trim()}`))
      }
    })
  })
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

function normalizeInt(value, defaultValue, min, max) {
  const parsed = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(parsed)) return defaultValue
  return Math.min(Math.max(parsed, min), max)
}

function buildHeaders(token) {
  const headers = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function requestJson(baseUrl, path, { token, method = 'get', params = {} } = {}) {
  const headers = buildHeaders(token)
  const requestMethod = method.toUpperCase()
  const url = new URL(`${baseUrl}${path}`)
  const init = { method: requestMethod, headers }

  if (requestMethod === 'GET') {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
  } else {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(params)
  }

  const startedAt = Date.now()
  let response
  try {
    response = await fetch(url, init)
  } catch (error) {
    throw new Error(`${requestMethod} ${url.toString()} failed: ${error.message || error}. Check that WeFlow API service is enabled and the host/port are correct.`)
  }
  const text = await response.text()
  const elapsedMs = Date.now() - startedAt

  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }

  if (!response.ok) {
    const detail = typeof data === 'string' ? data : JSON.stringify(data)
    throw new Error(`${requestMethod} ${url.pathname} failed: HTTP ${response.status} ${detail}`)
  }

  return { data, elapsedMs, status: response.status, url: url.toString() }
}

function summarizeSessions(data) {
  const sessions = Array.isArray(data?.sessions) ? data.sessions : []
  return sessions.map((session, index) => ({
    index: index + 1,
    id: session.username || session.id,
    name: session.displayName || session.name || '',
    type: session.sessionType || session.type,
    lastTimestamp: session.lastTimestamp || session.lastMessageAt || null
  }))
}

function summarizeMessages(data) {
  const messages = Array.isArray(data?.messages) ? data.messages : []
  return messages.map((message, index) => ({
    index: index + 1,
    localId: message.localId,
    serverId: message.serverId || message.platformMessageId,
    createTime: message.createTime || message.timestamp,
    sender: message.senderUsername || message.sender || '',
    type: message.localType ?? message.type,
    text: trimText(message.parsedContent || message.content || message.rawContent || '')
  }))
}

function trimText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printUsage()
    return
  }

  console.log(`[1/3] Health: ${args.baseUrl}/health`)
  const health = await requestJson(args.baseUrl, '/health')
  console.log(`      OK ${health.status}, ${health.elapsedMs}ms`)
  if (args.raw) printJson(health.data)

  if (!args.token && args.configCwd) {
    args.token = await readTokenFromConfig(args.configCwd, args.electron)
    console.log(`      Token loaded from ${join(args.configCwd, 'WeFlow-config.json')}`)
  }

  if (!args.token) {
    throw new Error('Missing API token. Set WEFLOW_API_TOKEN or pass --token. /health works without token, /api/v1/* does not.')
  }

  console.log(`[2/3] Sessions: limit=${args.sessionsLimit}, method=${args.method}`)
  const sessionsResult = await requestJson(args.baseUrl, '/api/v1/sessions', {
    token: args.token,
    method: args.method,
    params: { limit: args.sessionsLimit }
  })
  const sessions = Array.isArray(sessionsResult.data?.sessions) ? sessionsResult.data.sessions : []
  console.log(`      OK ${sessionsResult.status}, ${sessionsResult.elapsedMs}ms, count=${sessionsResult.data?.count ?? sessions.length}`)
  if (args.raw) {
    printJson(sessionsResult.data)
  } else {
    console.table(summarizeSessions(sessionsResult.data))
  }

  const selectedTalker = args.talker || sessions[0]?.username || sessions[0]?.id || ''
  if (!selectedTalker) {
    console.log('[3/3] Messages skipped: no session returned and --talker was not provided.')
    return
  }

  console.log(`[3/3] Messages: talker=${selectedTalker}, limit=${args.messagesLimit}, offset=${args.offset}, method=${args.method}`)
  const messageParams = {
    talker: selectedTalker,
    limit: args.messagesLimit,
    offset: args.offset,
    format: args.format,
    keyword: args.keyword,
    start: args.start,
    end: args.end
  }
  const messagesResult = await requestJson(args.baseUrl, '/api/v1/messages', {
    token: args.token,
    method: args.method,
    params: messageParams
  })
  const messages = Array.isArray(messagesResult.data?.messages) ? messagesResult.data.messages : []
  console.log(`      OK ${messagesResult.status}, ${messagesResult.elapsedMs}ms, count=${messagesResult.data?.count ?? messages.length}, hasMore=${messagesResult.data?.hasMore ?? 'n/a'}`)
  if (args.raw) {
    printJson(messagesResult.data)
  } else {
    console.table(summarizeMessages(messagesResult.data))
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error.message || error}`)
  process.exitCode = 1
})
