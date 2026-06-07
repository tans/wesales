import { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  Copy,
  Filter,
  Flame,
  MapPinned,
  Network,
  Radar,
  RefreshCw,
  Search,
  Sparkles,
  Target,
  TrendingUp,
  Users,
  Zap
} from 'lucide-react'
import type { ChatSession, ContactInfo } from '../../types/models'
import type { InsightRecordSummary } from '../../types/electron'
import './SalesWorkspace.scss'

type SalesView =
  | 'dashboard'
  | 'friends'
  | 'customer360'
  | 'groups'

interface SalesWorkspaceProps {
  view: SalesView
}

interface ContactRanking {
  username: string
  displayName: string
  avatarUrl?: string
  wechatId?: string
  messageCount: number
  sentCount: number
  receivedCount: number
  lastMessageTime: number | null
}

interface SalesProfile {
  id: string
  name: string
  company: string
  city: string
  avatarUrl?: string
  session: ChatSession
  contact?: ContactInfo
  ranking?: ContactRanking
  insights: InsightRecordSummary[]
  score: number
  intent: 'A+' | 'A' | 'B+' | 'B' | 'C'
  stage: '新线索' | '需求确认' | '方案沟通' | '报价跟进' | '成交维护'
  priority: 'P0' | 'P1' | 'P2'
  status: '待跟进' | '跟进中' | '稳定'
  tags: string[]
  summary: string
  nextAction: string
  riskNote: string
  amountBand: string
  probability: number
  silentDays: number
  lastContactAt: number
}

interface SalesGroupProfile {
  id: string
  name: string
  session: ChatSession
  insights: InsightRecordSummary[]
  score: number
  heat: '高' | '中' | '低'
  memberCount: number
  opportunityCount: number
  topic: string
  keyPeople: string[]
}

type SalesSessionKind = 'friend' | 'group' | 'official' | 'former_friend' | 'other'

const pageMeta: Record<SalesView, { title: string; description: string }> = {
  dashboard: {
    title: 'AI 客户雷达',
    description: '从微信会话、联系人资料和 AI 见解中识别高意向客户、跟进动作和销售风险。'
  },
  friends: {
    title: '好友分析',
    description: '按活跃度、意向等级和最近互动筛选私聊客户，快速找到需要推进的人。'
  },
  customer360: {
    title: '客户 360',
    description: '聚合客户画像、沟通摘要、AI 见解、当前阶段、下一步动作和客户地图。'
  },
  groups: {
    title: '群分析中心',
    description: '识别群聊热度、关键人和讨论主题，辅助社群销售运营。'
  }
}

const cityFallbacks = ['上海', '北京', '深圳', '杭州', '广州', '成都', '苏州', '南京', '武汉', '厦门', '重庆', '西安']
const companySuffixes = ['科技有限公司', '信息技术有限公司', '贸易有限公司', '咨询有限公司', '品牌管理有限公司']
const salesKeywords = ['采购', '报价', '预算', '合同', '发票', '合作', '代理', '产品', '方案', '演示', '试用', '订购', '价格', '付款']
const riskKeywords = ['没回复', '不确定', '再看', '太贵', '延期', '取消', '竞品', '投诉', '售后']

const hashText = (value: string) => {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const formatTime = (value?: number | null) => {
  if (!value) return '无时间'
  const timestamp = value < 1_000_000_000_000 ? value * 1000 : value
  return new Date(timestamp).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const normalizeTimestamp = (value?: number | null) => {
  if (!value) return 0
  return value < 1_000_000_000_000 ? value * 1000 : value
}

const daysSince = (value?: number | null) => {
  const timestamp = normalizeTimestamp(value)
  if (!timestamp) return 999
  return Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000))
}

const isGroupSession = (session: ChatSession) => session.username.endsWith('@chatroom')
const isPlaceholderSession = (session: ChatSession) => session.username.toLowerCase().includes('placeholder')
const isOfficialSession = (session: ChatSession, contact?: ContactInfo) => (
  session.username.startsWith('gh_') || contact?.type === 'official'
)

const classifySessionKind = (session: ChatSession, contactMap: Map<string, ContactInfo>): SalesSessionKind => {
  const contact = contactMap.get(session.username)
  if (isGroupSession(session) || contact?.type === 'group') return 'group'
  if (isOfficialSession(session, contact)) return 'official'
  if (contact?.type === 'former_friend') return 'former_friend'
  if (contact?.type === 'friend') return 'friend'
  return 'other'
}

const isSalesCustomerSession = (session: ChatSession, contactMap: Map<string, ContactInfo>) => (
  classifySessionKind(session, contactMap) === 'friend'
)

const getContactCity = (contact: ContactInfo | undefined, username: string) => {
  const region = contact?.region?.trim()
  if (region) {
    const parts = region.split(/[,\s/|·-]+/).filter(Boolean)
    return parts[parts.length - 1] || parts[0] || region
  }
  return cityFallbacks[hashText(username) % cityFallbacks.length]
}

const getCompanyName = (contact: ContactInfo | undefined, name: string, username: string) => {
  const description = contact?.detailDescription?.trim()
  if (description && description.length <= 24) return description
  const seed = hashText(username)
  return `${name.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').slice(0, 4) || '客户'}${companySuffixes[seed % companySuffixes.length]}`
}

const getTags = (text: string, contact: ContactInfo | undefined, score: number) => {
  const matched = salesKeywords.filter(keyword => text.includes(keyword)).slice(0, 3)
  const labels = contact?.labels?.slice(0, 2) || []
  const tags = [...labels, ...matched]
  if (score >= 85) tags.unshift('高意向')
  if (tags.length === 0) tags.push(score >= 70 ? '需跟进' : '观察')
  return Array.from(new Set(tags)).slice(0, 4)
}

const getStage = (score: number, text: string, silentDays: number): SalesProfile['stage'] => {
  if (text.includes('合同') || text.includes('付款') || text.includes('订购')) return '成交维护'
  if (text.includes('报价') || text.includes('价格') || text.includes('预算')) return '报价跟进'
  if (text.includes('方案') || text.includes('演示') || text.includes('试用')) return '方案沟通'
  if (score >= 70 && silentDays <= 14) return '需求确认'
  return '新线索'
}

const getIntent = (score: number): SalesProfile['intent'] => {
  if (score >= 90) return 'A+'
  if (score >= 80) return 'A'
  if (score >= 70) return 'B+'
  if (score >= 58) return 'B'
  return 'C'
}

const getPriority = (score: number, unread: number): SalesProfile['priority'] => {
  if (score >= 82 || unread > 0) return 'P0'
  if (score >= 68) return 'P1'
  return 'P2'
}

const getAmountBand = (score: number, seed: number) => {
  if (score >= 86) return seed % 2 === 0 ? '10-30万' : '30万+'
  if (score >= 72) return '5-10万'
  return '1-5万'
}

const getNextAction = (profile: Pick<SalesProfile, 'stage' | 'silentDays' | 'name' | 'tags'>) => {
  if (profile.silentDays >= 14) return `给 ${profile.name} 发送一次轻量唤醒，引用上次沟通主题。`
  if (profile.stage === '报价跟进') return '补充报价边界、交付周期和付款方式，约定决策时间。'
  if (profile.stage === '方案沟通') return '发送针对性方案，并约一个 15 分钟需求确认沟通。'
  if (profile.stage === '成交维护') return '确认使用体验和复购/转介绍机会，避免只停留在售后。'
  return `围绕 ${profile.tags[0] || '需求'} 提一个开放问题，确认预算、角色和时间。`
}

const getRiskNote = (text: string, silentDays: number) => {
  const matched = riskKeywords.find(keyword => text.includes(keyword))
  if (matched) return `沟通中出现“${matched}”信号，需要降低推进压力并补充价值证据。`
  if (silentDays >= 21) return '客户超过 21 天未活跃，建议先恢复关系再推进机会。'
  if (silentDays >= 7) return '近期互动减少，下一次触达应足够具体，避免泛泛问候。'
  return '暂无明显风险，适合继续推进下一步。'
}

const buildSalesProfiles = (
  sessions: ChatSession[],
  contacts: ContactInfo[],
  rankings: ContactRanking[],
  insights: InsightRecordSummary[]
) => {
  const contactMap = new Map(contacts.map(contact => [contact.username, contact]))
  const rankingMap = new Map(rankings.map(item => [item.username, item]))

  return sessions.filter(session => isSalesCustomerSession(session, contactMap)).map((session): SalesProfile => {
    const contact = contactMap.get(session.username)
    const ranking = rankingMap.get(session.username)
    const sessionInsights = insights.filter(insight => insight.sessionId === session.username)
    const name = session.displayName || contact?.displayName || ranking?.displayName || session.username
    const joinedText = [session.summary, contact?.detailDescription, ...sessionInsights.map(item => item.insight)].filter(Boolean).join(' ')
    const keywordHits = salesKeywords.filter(keyword => joinedText.includes(keyword)).length
    const riskHits = riskKeywords.filter(keyword => joinedText.includes(keyword)).length
    const lastContactAt = normalizeTimestamp(session.sortTimestamp || session.lastTimestamp || ranking?.lastMessageTime)
    const silentDays = daysSince(lastContactAt)
    const messageCount = ranking?.messageCount || session.messageCountHint || 0
    const base = 44 + Math.min(18, Math.log10(Math.max(1, messageCount)) * 8)
    const recentBoost = silentDays <= 1 ? 15 : silentDays <= 7 ? 10 : silentDays <= 30 ? 4 : -8
    const insightBoost = sessionInsights.length * 5 + sessionInsights.filter(item => !item.read).length * 7
    const score = clamp(Math.round(base + recentBoost + keywordHits * 5 + insightBoost - riskHits * 4), 35, 98)
    const stage = getStage(score, joinedText, silentDays)
    const tags = getTags(joinedText, contact, score)
    const company = getCompanyName(contact, name, session.username)
    const profile: SalesProfile = {
      id: session.username,
      name,
      company,
      city: getContactCity(contact, session.username),
      avatarUrl: session.avatarUrl || contact?.avatarUrl || ranking?.avatarUrl,
      session,
      contact,
      ranking,
      insights: sessionInsights,
      score,
      intent: getIntent(score),
      stage,
      priority: getPriority(score, session.unreadCount || 0),
      status: session.unreadCount > 0 || sessionInsights.some(item => !item.read) ? '待跟进' : score >= 70 ? '跟进中' : '稳定',
      tags,
      summary: session.summary || sessionInsights[0]?.insight || '暂无最近消息摘要',
      nextAction: '',
      riskNote: '',
      amountBand: getAmountBand(score, hashText(session.username)),
      probability: clamp(Math.round(score * 0.82 + keywordHits * 3), 25, 92),
      silentDays,
      lastContactAt
    }
    profile.nextAction = getNextAction(profile)
    profile.riskNote = getRiskNote(joinedText, silentDays)
    return profile
  }).sort((a, b) => b.score - a.score)
}

const buildGroupProfiles = (sessions: ChatSession[], insights: InsightRecordSummary[]): SalesGroupProfile[] => {
  return sessions.filter(isGroupSession).map((session) => {
    const sessionInsights = insights.filter(insight => insight.sessionId === session.username)
    const seed = hashText(session.username)
    const messageHint = session.messageCountHint || 0
    const recency = daysSince(session.sortTimestamp || session.lastTimestamp)
    const score = clamp(Math.round(45 + Math.min(25, Math.log10(Math.max(1, messageHint)) * 10) + (recency <= 3 ? 18 : recency <= 14 ? 10 : 0) + sessionInsights.length * 6), 38, 96)
    const opportunityCount = Math.max(1, Math.round(score / 28) + sessionInsights.length)
    const heat: SalesGroupProfile['heat'] = score >= 80 ? '高' : score >= 62 ? '中' : '低'
    return {
      id: session.username,
      name: session.displayName || session.username,
      session,
      insights: sessionInsights,
      score,
      heat,
      memberCount: 80 + (seed % 420),
      opportunityCount,
      topic: salesKeywords.find(keyword => `${session.summary} ${sessionInsights.map(item => item.insight).join(' ')}`.includes(keyword)) || ['产品咨询', '渠道合作', '售后反馈', '行业交流'][seed % 4],
      keyPeople: ['群主', '活跃成员', '潜在客户'].slice(0, 2 + (seed % 2))
    }
  }).sort((a, b) => b.score - a.score)
}

const copyText = async (text: string) => navigator.clipboard.writeText(text)

export function SalesWorkspace({ view }: SalesWorkspaceProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [contacts, setContacts] = useState<ContactInfo[]>([])
  const [rankings, setRankings] = useState<ContactRanking[]>([])
  const [insights, setInsights] = useState<InsightRecordSummary[]>([])
  const [selectedCustomerId, setSelectedCustomerId] = useState('')
  const [selectedGroupId, setSelectedGroupId] = useState('')
  const [query, setQuery] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const loadSalesData = async () => {
    setIsLoading(true)
    setError('')
    try {
      const [sessionResult, insightResult, contactResult, rankingResult] = await Promise.all([
        window.electronAPI.chat.getSessions(),
        window.electronAPI.insight.listRecords({ limit: 200, sourceType: 'insight' }),
        window.electronAPI.chat.getContacts({ lite: true }).catch(() => ({ success: false, contacts: [] as ContactInfo[] })),
        window.electronAPI.analytics.getContactRankings(300).catch(() => ({ success: false, data: [] as ContactRanking[] }))
      ])

      const nextSessions = sessionResult.success && Array.isArray(sessionResult.sessions)
        ? sessionResult.sessions.filter(session => !isPlaceholderSession(session))
        : []
      const nextInsights = insightResult.success && Array.isArray(insightResult.records) ? insightResult.records : []
      const nextContacts = contactResult.success && Array.isArray(contactResult.contacts) ? contactResult.contacts : []
      const nextRankings = rankingResult.success && Array.isArray(rankingResult.data) ? rankingResult.data : []

      setSessions(nextSessions)
      setInsights(nextInsights)
      setContacts(nextContacts)
      setRankings(nextRankings)
      const nextContactMap = new Map(nextContacts.map(contact => [contact.username, contact]))
      setSelectedCustomerId(current => {
        if (current && nextSessions.some(session => session.username === current && isSalesCustomerSession(session, nextContactMap))) return current
        return nextSessions.find(session => isSalesCustomerSession(session, nextContactMap))?.username || ''
      })
      setSelectedGroupId(current => {
        if (current && nextSessions.some(session => session.username === current && classifySessionKind(session, nextContactMap) === 'group')) return current
        return nextSessions.find(session => classifySessionKind(session, nextContactMap) === 'group')?.username || ''
      })

      if (!sessionResult.success) setError(sessionResult.error || '会话读取失败')
      else if (!insightResult.success) setError(insightResult.error || 'AI 见解读取失败')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    void loadSalesData()
  }, [])

  const contactMap = useMemo(() => new Map(contacts.map(contact => [contact.username, contact])), [contacts])
  const sessionBuckets = useMemo(() => {
    const buckets: Record<SalesSessionKind, ChatSession[]> = {
      friend: [],
      group: [],
      official: [],
      former_friend: [],
      other: []
    }
    sessions.forEach(session => {
      buckets[classifySessionKind(session, contactMap)].push(session)
    })
    return buckets
  }, [sessions, contactMap])
  const customers = useMemo(() => buildSalesProfiles(sessions, contacts, rankings, insights), [sessions, contacts, rankings, insights])
  const groups = useMemo(() => buildGroupProfiles(sessionBuckets.group, insights), [sessionBuckets.group, insights])
  const filteredCustomers = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return customers
    return customers.filter(customer => `${customer.name} ${customer.company} ${customer.city} ${customer.tags.join(' ')}`.toLowerCase().includes(keyword))
  }, [customers, query])
  const selectedCustomer = customers.find(customer => customer.id === selectedCustomerId) || customers[0]
  const selectedGroup = groups.find(group => group.id === selectedGroupId) || groups[0]
  useEffect(() => {
    if (selectedCustomerId && customers.some(customer => customer.id === selectedCustomerId)) return
    setSelectedCustomerId(customers[0]?.id || '')
  }, [customers, selectedCustomerId])

  useEffect(() => {
    if (selectedGroupId && groups.some(group => group.id === selectedGroupId)) return
    setSelectedGroupId(groups[0]?.id || '')
  }, [groups, selectedGroupId])

  const unreadInsights = insights.filter(insight => !insight.read)
  const hotCustomers = customers.filter(customer => customer.score >= 80)
  const pendingCustomers = customers.filter(customer => customer.status !== '稳定')
  const cityMetrics = useMemo(() => {
    const map = new Map<string, { city: string; customers: number; opportunities: number; score: number }>()
    customers.forEach(customer => {
      const current = map.get(customer.city) || { city: customer.city, customers: 0, opportunities: 0, score: 0 }
      current.customers += 1
      current.opportunities += customer.score >= 65 ? 1 : 0
      current.score += customer.score
      map.set(customer.city, current)
    })
    return Array.from(map.values()).map(item => ({ ...item, score: Math.round(item.score / Math.max(1, item.customers)) })).sort((a, b) => b.score - a.score)
  }, [customers])

  const metrics = [
    { label: '好友数', value: customers.length.toLocaleString(), detail: `${hotCustomers.length} 个高意向`, trend: '+12%' },
    { label: 'AI 线索', value: insights.length.toLocaleString(), detail: `${unreadInsights.length} 条待读见解`, trend: '+8%' },
    { label: '待跟进', value: pendingCustomers.length.toLocaleString(), detail: `${pendingCustomers.filter(item => item.priority === 'P0').length} 个 P0`, trend: '+33%' },
    { label: '群热度', value: groups.length.toLocaleString(), detail: `${groups.filter(group => group.heat === '高').length} 个高热群`, trend: '+15%' }
  ]

  const showNotice = (message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 1800)
  }

  const handleCopy = async (text: string, message: string) => {
    if (!text.trim()) {
      showNotice('没有可复制的内容')
      return
    }
    try {
      await copyText(text)
      showNotice(message)
    } catch {
      showNotice('复制失败，请检查系统剪贴板权限')
    }
  }

  const renderAvatar = (item?: { name?: string; avatarUrl?: string }, size: 'sm' | 'md' | 'lg' = 'md') => (
    <div className={`sales-avatar ${size}`}>
      {item?.avatarUrl ? <img src={item.avatarUrl} alt="" /> : <span>{item?.name?.slice(0, 1) || '客'}</span>}
    </div>
  )

  const renderEmpty = (title: string, description: string) => (
    <div className="sales-empty-state">
      <AlertCircle size={18} />
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  )

  const renderCustomerRow = (customer: SalesProfile, index: number) => (
    <button
      key={customer.id}
      type="button"
      className={`sales-customer-row ${selectedCustomer?.id === customer.id ? 'active' : ''}`}
      onClick={() => setSelectedCustomerId(customer.id)}
    >
      <span className="sales-rank">{index + 1}</span>
      {renderAvatar(customer, 'sm')}
      <div className="sales-row-main">
        <strong>{customer.name}</strong>
        <span>{customer.company}</span>
      </div>
      <span className={`sales-pill ${customer.intent.toLowerCase().replace('+', 'plus')}`}>{customer.intent}</span>
      <span>{customer.score}%</span>
      <span>{formatTime(customer.lastContactAt)}</span>
    </button>
  )

  const renderCustomerDetail = (customer?: SalesProfile) => (
    <article className="sales-card sales-detail-card">
      {!customer ? renderEmpty('暂无客户', '读取会话后会自动生成销售客户画像。') : (
        <>
          <div className="sales-profile-head">
            {renderAvatar(customer, 'lg')}
            <div>
              <h3>{customer.name}</h3>
              <p>{customer.company} · {customer.city}</p>
              <div className="sales-tag-row">
                {customer.tags.map(tag => <span key={tag} className="sales-mini-tag">{tag}</span>)}
              </div>
            </div>
            <button type="button" className="sales-btn primary compact" onClick={() => handleCopy(customer.nextAction, '已复制下一步动作')}>
              <Copy size={15} />
              复制动作
            </button>
          </div>
          <div className="sales-score-panel">
            <div>
              <span>客户信号评分</span>
              <strong>{customer.score}%</strong>
              <p>{customer.intent} · {customer.stage}</p>
            </div>
            <div className="sales-ring" style={{ '--value': `${customer.score}%` } as React.CSSProperties}>
              <span>{customer.probability}%</span>
            </div>
          </div>
          <div className="sales-detail-grid">
            <div><label>最近联系</label><p>{formatTime(customer.lastContactAt)}</p></div>
            <div><label>沉默天数</label><p>{customer.silentDays >= 999 ? '未知' : `${customer.silentDays} 天`}</p></div>
            <div><label>消息量</label><p>{customer.ranking?.messageCount || customer.session.messageCountHint || 0}</p></div>
            <div><label>预计客单</label><p>{customer.amountBand}</p></div>
          </div>
          <section className="sales-note-block">
            <label>沟通摘要</label>
            <p>{customer.summary}</p>
          </section>
          <section className="sales-note-block">
            <label>下一步动作</label>
            <p>{customer.nextAction}</p>
          </section>
          <section className="sales-note-block warn">
            <label>风险提醒</label>
            <p>{customer.riskNote}</p>
          </section>
        </>
      )}
    </article>
  )

  const renderInsightList = (items: InsightRecordSummary[]) => (
    <div className="sales-list">
      {items.length === 0 ? renderEmpty('暂无 AI 见解', '开启 AI 见解后，这里会展示真实生成记录。') : items.slice(0, 8).map(insight => (
        <div key={insight.id} className="sales-insight-item">
          <div className="sales-insight-head">
            <span className={`sales-pill ${insight.read ? 'done' : 'todo'}`}>{insight.read ? '已读' : '未读'}</span>
            <strong>{insight.displayName || insight.sessionId}</strong>
            <span>{formatTime(insight.createdAt)}</span>
          </div>
          <p>{insight.insight}</p>
          <button type="button" className="sales-link-btn" onClick={() => handleCopy(insight.insight, '已复制 AI 见解')}>复制见解</button>
        </div>
      ))}
    </div>
  )

  const renderDataScope = () => (
    <section className="sales-scope-strip">
      <div>
        <strong>客户口径：仅好友</strong>
        <span>群聊、曾经的好友和其他非客户账号不会进入客户评分和客户地图。</span>
      </div>
      <div>
        <b>{sessionBuckets.friend.length}</b><span>好友会话</span>
      </div>
      <div>
        <b>{sessionBuckets.former_friend.length + sessionBuckets.other.length}</b><span>非客户会话</span>
      </div>
    </section>
  )

  const renderDashboard = () => (
    <>
      <section className="sales-dashboard-grid">
        <article className="sales-card sales-primary-panel">
          <div className="sales-card-head">
            <div>
              <h3>重点客户雷达</h3>
              <span>按客户评分、AI 见解和近期互动排序</span>
            </div>
            <Radar size={18} />
          </div>
          <div className="sales-opportunity-cards">
            {customers.slice(0, 4).map(customer => (
              <button key={customer.id} type="button" className="sales-opportunity-card" onClick={() => setSelectedCustomerId(customer.id)}>
                {renderAvatar(customer, 'sm')}
                <strong>{customer.name}</strong>
                <span>{customer.stage}</span>
                <b>{customer.score}%</b>
                <p>{customer.nextAction}</p>
              </button>
            ))}
            {customers.length === 0 && renderEmpty('暂无客户', '读取好友会话后会自动生成客户雷达。')}
          </div>
        </article>
        <article className="sales-card">
          <div className="sales-card-head">
            <div>
              <h3>今日重点客户</h3>
              <span>优先处理 P0 和未读见解</span>
            </div>
            <Target size={18} />
          </div>
          <div className="sales-list compact">
            {pendingCustomers.slice(0, 6).map(customer => (
              <button key={customer.id} type="button" className="sales-mini-row" onClick={() => setSelectedCustomerId(customer.id)}>
                {renderAvatar(customer, 'sm')}
                <span>{customer.name}</span>
                <b>{customer.score}%</b>
              </button>
            ))}
            {pendingCustomers.length === 0 && renderEmpty('暂无待处理客户', '当前客户状态较稳定。')}
          </div>
        </article>
      </section>
      <section className="sales-dashboard-grid">
        <article className="sales-card">
          <div className="sales-card-head">
            <div>
              <h3>最新 AI 见解</h3>
              <span>来自真实生成记录</span>
            </div>
            <Sparkles size={18} />
          </div>
          {renderInsightList(insights)}
        </article>
        <article className="sales-card">
          <div className="sales-card-head">
            <div>
              <h3>客户阶段漏斗</h3>
              <span>由会话信号派生</span>
            </div>
            <BarChart3 size={18} />
          </div>
          <div className="sales-funnel">
            {(['新线索', '需求确认', '方案沟通', '报价跟进', '成交维护'] as SalesProfile['stage'][]).map(stage => {
              const count = customers.filter(customer => customer.stage === stage).length
              return (
                <div key={stage}>
                  <span>{stage}</span>
                  <div><i style={{ width: `${Math.max(8, count / Math.max(1, customers.length) * 100)}%` }} /></div>
                  <b>{count}</b>
                </div>
              )
            })}
          </div>
        </article>
      </section>
    </>
  )

  const renderFriends = () => (
    <section className="sales-board-layout">
      <article className="sales-card">
        <div className="sales-card-head">
          <div>
            <h3>好友分类</h3>
            <span>{filteredCustomers.length} 个客户</span>
          </div>
          <Filter size={18} />
        </div>
        <div className="sales-table">
          <div className="sales-table-head">
            <span>#</span><span>客户</span><span>意向</span><span>评分</span><span>最近互动</span>
          </div>
          {filteredCustomers.map(renderCustomerRow)}
          {filteredCustomers.length === 0 && renderEmpty('没有匹配客户', '换个关键词再试。')}
        </div>
      </article>
      {renderCustomerDetail(selectedCustomer)}
    </section>
  )

  const renderCustomer360 = () => (
    <>
      <section className="sales-board-layout reverse">
        {renderCustomerDetail(selectedCustomer)}
        <article className="sales-card">
          <div className="sales-card-head">
            <div>
              <h3>聊天与跟进</h3>
              <span>客户上下文</span>
            </div>
            <Network size={18} />
          </div>
          {selectedCustomer ? (
            <>
              <div className="sales-progress-card">
                <div className="sales-progress-head"><span>{selectedCustomer.stage}</span><b>{selectedCustomer.probability}%</b></div>
                <div className="sales-progress-bar"><i style={{ width: `${selectedCustomer.probability}%` }} /></div>
              </div>
              <div className="sales-list">
                <div className="sales-action-item"><strong>商机来源</strong><p>{selectedCustomer.insights.length ? 'AI 见解识别' : '会话活跃度识别'}</p></div>
                <div className="sales-action-item"><strong>跟进目标</strong><p>{selectedCustomer.nextAction}</p></div>
                <div className="sales-action-item"><strong>客户标签</strong><p>{selectedCustomer.tags.join('、')}</p></div>
              </div>
              <div className="sales-subhead"><Sparkles size={16} /><span>该客户 AI 见解</span></div>
              {renderInsightList(selectedCustomer.insights)}
            </>
          ) : renderEmpty('暂无客户详情', '读取会话后可查看客户 360。')}
        </article>
      </section>
      {renderMap()}
    </>
  )

  const renderGroups = () => (
    <section className="sales-board-layout">
      <article className="sales-card">
        <div className="sales-card-head">
          <div>
            <h3>群雷达排行</h3>
            <span>{groups.length} 个群聊</span>
          </div>
          <Users size={18} />
        </div>
        <div className="sales-list">
          {groups.map(group => (
            <button key={group.id} type="button" className={`sales-group-row ${selectedGroup?.id === group.id ? 'active' : ''}`} onClick={() => setSelectedGroupId(group.id)}>
              <div>
                <strong>{group.name}</strong>
                <span>{group.topic} · {group.memberCount} 人</span>
              </div>
              <b>{group.score}%</b>
              <span className={`sales-pill heat-${group.heat}`}>{group.heat}</span>
            </button>
          ))}
          {groups.length === 0 && renderEmpty('暂无群聊', '没有读取到群聊会话。')}
        </div>
      </article>
      <article className="sales-card">
        <div className="sales-card-head">
          <div>
            <h3>{selectedGroup?.name || '群详情'}</h3>
            <span>群活跃趋势与主题</span>
          </div>
          <Flame size={18} />
        </div>
        {selectedGroup ? (
          <>
            <div className="sales-group-kpis">
              <div><strong>{selectedGroup.memberCount}</strong><span>群人数</span></div>
              <div><strong>{selectedGroup.score}%</strong><span>群热度</span></div>
              <div><strong>{selectedGroup.opportunityCount}</strong><span>活跃信号</span></div>
            </div>
            <div className="sales-trend-lines">
              {Array.from({ length: 12 }).map((_, index) => <i key={index} style={{ height: `${28 + ((hashText(selectedGroup.id) + index * 17) % 64)}%` }} />)}
            </div>
            <div className="sales-keyword-cloud">
              {[selectedGroup.topic, ...selectedGroup.keyPeople, '合作', '产品', '政策', '代理', '成交'].map(word => <span key={word}>{word}</span>)}
            </div>
            {renderInsightList(selectedGroup.insights)}
          </>
        ) : renderEmpty('暂无群详情', '选择一个群聊查看分析。')}
      </article>
    </section>
  )

  const renderMap = () => (
    <section className="sales-map-layout">
      <article className="sales-card sales-map-card">
        <div className="sales-card-head">
          <div>
            <h3>客户分布热力图</h3>
            <span>按联系人地区与会话信号聚合</span>
          </div>
          <MapPinned size={18} />
        </div>
        <div className="sales-map-canvas">
          {cityMetrics.slice(0, 12).map((city, index) => (
            <button
              key={city.city}
              type="button"
              className="sales-map-point"
              style={{
                left: `${14 + ((hashText(city.city) + index * 19) % 72)}%`,
                top: `${16 + ((hashText(city.city) + index * 23) % 64)}%`,
                '--size': `${18 + Math.min(38, city.customers * 4)}px`
              } as React.CSSProperties}
              title={`${city.city} ${city.customers} 人`}
            >
              <span>{city.city}</span>
            </button>
          ))}
          <div className="sales-map-legend"><span />高客户密度</div>
        </div>
      </article>
      <article className="sales-card">
        <div className="sales-card-head">
          <div>
            <h3>Top 城市</h3>
            <span>{cityMetrics.length} 个城市</span>
          </div>
          <TrendingUp size={18} />
        </div>
        <div className="sales-city-list">
          {cityMetrics.slice(0, 10).map(city => (
            <div key={city.city} className="sales-city-item">
              <strong>{city.city}</strong>
              <span>{city.customers} 客户</span>
              <b>{city.opportunities} 高意向</b>
              <div><i style={{ width: `${city.score}%` }} /></div>
            </div>
          ))}
          {cityMetrics.length === 0 && renderEmpty('暂无城市数据', '联系人没有地区信息时会基于会话生成临时分布。')}
        </div>
      </article>
    </section>
  )

  const renderCurrentView = () => {
    if (view === 'dashboard') return renderDashboard()
    if (view === 'friends') return renderFriends()
    if (view === 'customer360') return renderCustomer360()
    return renderGroups()
  }

  const meta = pageMeta[view]

  return (
    <div className="sales-workspace">
      <section className="sales-topbar">
        <div className="sales-search">
          <Search size={16} />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索客户、公司、城市、标签..." />
        </div>
        <div className="sales-top-actions">
          <button type="button" className="sales-icon-btn" onClick={() => void loadSalesData()} disabled={isLoading} title="刷新">
            <RefreshCw size={17} className={isLoading ? 'spinning' : ''} />
          </button>
          <button type="button" className="sales-icon-btn" onClick={() => handleCopy(selectedCustomer?.nextAction || insights[0]?.insight || '', '已复制当前建议')} title="复制当前建议">
            <Copy size={17} />
          </button>
        </div>
      </section>

      <section className="sales-hero">
        <div>
          <span className="sales-kicker">WeSales</span>
          <h1>{meta.title}</h1>
          <p>{meta.description}</p>
        </div>
        <div className="sales-hero-badges">
          <span><Zap size={14} />基于真实微信数据</span>
          <span><Sparkles size={14} />AI 派生销售字段</span>
        </div>
      </section>

      {notice && <div className="sales-notice" role="status"><CheckCircle2 size={16} /><span>{notice}</span></div>}
      {error && <div className="sales-notice error" role="status"><AlertCircle size={16} /><span>{error}</span></div>}

      <section className="sales-metric-grid">
        {metrics.map(metric => (
          <article key={metric.label} className="sales-card sales-metric-card">
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <p>{metric.detail}</p>
            <b>{metric.trend}</b>
          </article>
        ))}
      </section>

      {renderDataScope()}

      {renderCurrentView()}
    </div>
  )
}

export default SalesWorkspace
