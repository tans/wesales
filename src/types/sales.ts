export type SalesPriority = 'P0' | 'P1' | 'P2'
export type SalesStatus = '待处理' | '处理中' | '已处理'
export type IntentLevel = '高意向' | '中意向' | '观察中'
export type OpportunityStage = '线索识别' | '需求确认' | '方案沟通' | '报价跟进' | '待决策'

export interface SalesMessageEvidence {
  id: string
  time: string
  speaker: string
  channel: string
  summary: string
  quote: string
}

export interface SalesTask {
  id: string
  title: string
  dueLabel: string
  owner: string
  status: SalesStatus
}

export interface SalesInsight {
  id: string
  title: string
  summary: string
  priority: SalesPriority
  status: SalesStatus
  customerId?: string
  groupId?: string
  evidenceIds: string[]
  suggestedReply: string
  suggestedAction: string
}

export interface SalesCustomer {
  id: string
  name: string
  company: string
  city: string
  owner: string
  source: string
  score: number
  intent: IntentLevel
  stage: OpportunityStage
  status: SalesStatus
  tags: string[]
  lastContact: string
  nextStep: string
  valueBand: string
  relationSummary: string
  silentDays: number
  riskNote: string
  suggestedReply: string
  aiSummary: string
  evidenceIds: string[]
  relatedGroupIds: string[]
  taskIds: string[]
}

export interface SalesGroup {
  id: string
  name: string
  topic: string
  city: string
  memberCount: number
  activityScore: number
  opportunityCount: number
  heat: '高' | '中' | '低'
  keyPeople: string[]
  highlights: string[]
  evidenceIds: string[]
}

export interface SalesOpportunity {
  id: string
  title: string
  customerId: string
  source: string
  stage: OpportunityStage
  priority: SalesPriority
  probability: number
  amountBand: string
  blocker: string
  nextAction: string
  status: SalesStatus
  evidenceIds: string[]
}

export interface SalesTimelineEvent {
  id: string
  date: string
  type: '消息证据' | '任务记录' | '机会变化' | 'AI建议'
  title: string
  detail: string
  customerId?: string
  opportunityId?: string
  evidenceIds: string[]
}

export interface SalesCityMetric {
  city: string
  customers: number
  opportunities: number
  hotScore: number
}

export interface SalesAssistantDraft {
  id: string
  customerId: string
  title: string
  scenario: string
  talkTrack: string
  planDraft: string
  caution: string
  evidenceIds: string[]
}

export interface SalesDataset {
  customers: SalesCustomer[]
  groups: SalesGroup[]
  opportunities: SalesOpportunity[]
  insights: SalesInsight[]
  evidence: SalesMessageEvidence[]
  timeline: SalesTimelineEvent[]
  cityMetrics: SalesCityMetric[]
  tasks: SalesTask[]
  assistantDrafts: SalesAssistantDraft[]
}
