import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { Users, BarChart3, Clock, Image, Loader2, RefreshCw, Medal, Search, X, ChevronLeft } from 'lucide-react'
import { Avatar } from '../components/Avatar'
import ReactECharts from 'echarts-for-react'
import DateRangePicker from '../components/DateRangePicker'
import ChatAnalysisHeader from '../components/ChatAnalysisHeader'
import {
  finishBackgroundTask,
  isBackgroundTaskCancelRequested,
  registerBackgroundTask,
  updateBackgroundTask
} from '../services/backgroundTaskMonitor'
import './GroupAnalyticsPage.scss'

interface GroupChatInfo {
  username: string
  displayName: string
  avatarUrl?: string
}

interface GroupMember {
  username: string
  displayName: string
  avatarUrl?: string
  nickname?: string
  alias?: string
  remark?: string
  groupNickname?: string
}

interface GroupMessageRank {
  member: GroupMember
  messageCount: number
}

type AnalysisFunction = 'ranking' | 'activeHours' | 'mediaStats'

function GroupAnalyticsPage() {
  const location = useLocation()
  const [groups, setGroups] = useState<GroupChatInfo[]>([])
  const [filteredGroups, setFilteredGroups] = useState<GroupChatInfo[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [selectedFunction, setSelectedFunction] = useState<AnalysisFunction | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const selectedGroup = useMemo(
    () => (selectedGroupId ? groups.find(group => group.username === selectedGroupId) || null : null),
    [groups, selectedGroupId]
  )

  // 功能数据
  const [rankings, setRankings] = useState<GroupMessageRank[]>([])
  const [activeHours, setActiveHours] = useState<Record<number, number>>({})
  const [mediaStats, setMediaStats] = useState<{ typeCounts: Array<{ type: number; name: string; count: number }>; total: number } | null>(null)
  const [functionLoading, setFunctionLoading] = useState(false)

  // 时间范围
  const [startDate, setStartDate] = useState<string>('')
  const [endDate, setEndDate] = useState<string>('')
  const [dateRangeReady, setDateRangeReady] = useState(false)

  // 拖动调整宽度
  const [sidebarWidth, setSidebarWidth] = useState(300)
  const [isResizing, setIsResizing] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const preselectAppliedRef = useRef(false)

  const preselectGroupIds = useMemo(() => {
    const state = location.state as { preselectGroupIds?: unknown; preselectGroupId?: unknown } | null
    const rawList = Array.isArray(state?.preselectGroupIds)
      ? state.preselectGroupIds
      : (typeof state?.preselectGroupId === 'string' ? [state.preselectGroupId] : [])

    return rawList
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean)
  }, [location.state])

  const getSelectedTimeRange = () => ({
    startTime: startDate ? Math.floor(new Date(startDate).getTime() / 1000) : undefined,
    endTime: endDate ? Math.floor(new Date(`${endDate}T23:59:59`).getTime() / 1000) : undefined
  })

  const loadGroups = useCallback(async () => {
    const taskId = registerBackgroundTask({
      sourcePage: 'groupAnalytics',
      title: '群列表加载',
      detail: '正在读取群聊列表',
      progressText: '群聊列表',
      cancelable: true
    })
    setIsLoading(true)
    try {
      const result = await window.electronAPI.groupAnalytics.getGroupChats()
      if (isBackgroundTaskCancelRequested(taskId)) {
        finishBackgroundTask(taskId, 'canceled', {
          detail: '已停止后续加载，群聊列表结果未继续写入'
        })
        return
      }
      if (result.success && result.data) {
        setGroups(result.data)
        setFilteredGroups(result.data)
        finishBackgroundTask(taskId, 'completed', {
          detail: `群聊列表加载完成，共 ${result.data.length} 个群`,
          progressText: `${result.data.length} 个群`
        })
      } else {
        finishBackgroundTask(taskId, 'failed', {
          detail: result.error || '加载群聊列表失败'
        })
      }
    } catch (e) {
      console.error(e)
      finishBackgroundTask(taskId, 'failed', {
        detail: String(e)
      })
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadGroups()
  }, [loadGroups])

  useEffect(() => {
    preselectAppliedRef.current = false
  }, [location.key, preselectGroupIds])

  useEffect(() => {
    if (searchQuery) {
      setFilteredGroups(groups.filter(g => g.displayName.toLowerCase().includes(searchQuery.toLowerCase())))
    } else {
      setFilteredGroups(groups)
    }
  }, [searchQuery, groups])

  useEffect(() => {
    if (preselectAppliedRef.current) return
    if (groups.length === 0 || preselectGroupIds.length === 0) return

    const matchedGroup = groups.find(group => preselectGroupIds.includes(group.username))
    preselectAppliedRef.current = true

    if (matchedGroup) {
      setSelectedGroupId(matchedGroup.username)
      setSelectedFunction(null)
      setSearchQuery('')
    }
  }, [groups, preselectGroupIds])

  // 拖动调整宽度
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing || !containerRef.current) return
      const containerRect = containerRef.current.getBoundingClientRect()
      const newWidth = e.clientX - containerRect.left
      setSidebarWidth(Math.max(250, Math.min(450, newWidth)))
    }
    const handleMouseUp = () => setIsResizing(false)
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    }
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing])

  // 日期范围变化时自动刷新
  useEffect(() => {
    if (dateRangeReady && selectedGroup && selectedFunction) {
      setDateRangeReady(false)
      loadFunctionData(selectedFunction)
    }
  }, [dateRangeReady])

  useEffect(() => {
    const handleChange = () => {
      setGroups([])
      setFilteredGroups([])
      setSelectedGroupId(null)
      setSelectedFunction(null)
      setRankings([])
      setActiveHours({})
      setMediaStats(null)
      void loadGroups()
    }
    window.addEventListener('wxid-changed', handleChange as EventListener)
    return () => window.removeEventListener('wxid-changed', handleChange as EventListener)
  }, [loadGroups])

  const handleGroupSelect = (group: GroupChatInfo) => {
    setSelectedGroupId(group.username)
    setSelectedFunction(null)
  }

  const handleFunctionSelect = async (func: AnalysisFunction) => {
    if (!selectedGroup) return
    setSelectedFunction(func)
    await loadFunctionData(func)
  }

  const loadFunctionData = async (
    func: AnalysisFunction,
    targetGroup: GroupChatInfo | null = selectedGroup
  ) => {
    if (!targetGroup) return
    const taskId = registerBackgroundTask({
      sourcePage: 'groupAnalytics',
      title: `群分析：${func}`,
      detail: `正在读取 ${targetGroup.displayName || targetGroup.username} 的分析数据`,
      progressText: func,
      cancelable: true
    })
    setFunctionLoading(true)

    const { startTime, endTime } = getSelectedTimeRange()

    try {
      switch (func) {
        case 'ranking': {
          setRankings([])
          updateBackgroundTask(taskId, {
            detail: '正在计算群消息排行',
            progressText: '消息排行'
          })
          const result = await window.electronAPI.groupAnalytics.getGroupMessageRanking(targetGroup.username, 20, startTime, endTime)
          if (isBackgroundTaskCancelRequested(taskId)) {
            finishBackgroundTask(taskId, 'canceled', { detail: '已停止后续加载，群消息排行未继续写入' })
            return
          }
          if (result.success && result.data) setRankings(result.data)
          finishBackgroundTask(taskId, result.success ? 'completed' : 'failed', {
            detail: result.success ? `群消息排行加载完成，共 ${result.data?.length || 0} 条` : (result.error || '读取群消息排行失败'),
            progressText: result.success ? `${result.data?.length || 0} 条` : '失败'
          })
          break
        }
        case 'activeHours': {
          setActiveHours({})
          updateBackgroundTask(taskId, {
            detail: '正在计算群活跃时段',
            progressText: '活跃时段'
          })
          const result = await window.electronAPI.groupAnalytics.getGroupActiveHours(targetGroup.username, startTime, endTime)
          if (isBackgroundTaskCancelRequested(taskId)) {
            finishBackgroundTask(taskId, 'canceled', { detail: '已停止后续加载，群活跃时段未继续写入' })
            return
          }
          if (result.success && result.data) setActiveHours(result.data.hourlyDistribution)
          finishBackgroundTask(taskId, result.success ? 'completed' : 'failed', {
            detail: result.success ? '群活跃时段加载完成' : (result.error || '读取群活跃时段失败'),
            progressText: result.success ? '24 小时分布' : '失败'
          })
          break
        }
        case 'mediaStats': {
          setMediaStats(null)
          updateBackgroundTask(taskId, {
            detail: '正在统计群消息类型',
            progressText: '消息类型'
          })
          const result = await window.electronAPI.groupAnalytics.getGroupMediaStats(targetGroup.username, startTime, endTime)
          if (isBackgroundTaskCancelRequested(taskId)) {
            finishBackgroundTask(taskId, 'canceled', { detail: '已停止后续加载，群消息类型统计未继续写入' })
            return
          }
          if (result.success && result.data) setMediaStats(result.data)
          finishBackgroundTask(taskId, result.success ? 'completed' : 'failed', {
            detail: result.success ? `群消息类型统计完成，共 ${result.data?.total || 0} 条` : (result.error || '读取群消息类型统计失败'),
            progressText: result.success ? `${result.data?.total || 0} 条` : '失败'
          })
          break
        }
      }
    } catch (e) {
      console.error(e)
      finishBackgroundTask(taskId, 'failed', {
        detail: String(e)
      })
    } finally {
      setFunctionLoading(false)
    }
  }

  const formatNumber = (num: number) => {
    if (num >= 10000) return (num / 10000).toFixed(1) + '万'
    return num.toLocaleString()
  }

  const formatDate = (timestamp: number | null) => {
    if (!timestamp) return '-'
    const date = new Date(timestamp * 1000)
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
  }

  const getHourlyOption = () => {
    const hours = Array.from({ length: 24 }, (_, i) => i)
    const data = hours.map(h => activeHours[h] || 0)
    return {
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: hours.map(h => `${h}时`) },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', data, itemStyle: { color: '#07c160', borderRadius: [4, 4, 0, 0] } }]
    }
  }

  const getMediaOption = () => {
    if (!mediaStats || mediaStats.typeCounts.length === 0) return {}

    // 定义颜色映射
    const colorMap: Record<number, string> = {
      1: '#3b82f6',   // 文本 - 蓝色
      3: '#22c55e',   // 图片 - 绿色
      34: '#f97316',  // 语音 - 橙色
      43: '#a855f7',  // 视频 - 紫色
      47: '#ec4899',  // 表情包 - 粉色
      49: '#14b8a6',  // 链接/文件 - 青色
      [-1]: '#6b7280', // 其他 - 灰色
    }

    const data = mediaStats.typeCounts.map(item => ({
      name: item.name,
      value: item.count,
      itemStyle: { color: colorMap[item.type] || '#6b7280' }
    }))

    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      series: [{
        type: 'pie',
        radius: ['40%', '70%'],
        center: ['50%', '50%'],
        itemStyle: { borderRadius: 8, borderColor: 'rgba(255,255,255,0.1)', borderWidth: 2 },
        label: {
          show: true,
          formatter: (params: { name: string; percent: number }) => {
            // 只显示占比大于3%的标签
            return params.percent > 3 ? `${params.name}\n${params.percent.toFixed(1)}%` : ''
          },
          color: '#fff'
        },
        labelLine: {
          show: true,
          length: 10,
          length2: 10
        },
        data
      }]
    }
  }

  const handleRefresh = () => {
    if (selectedFunction) {
      void loadFunctionData(selectedFunction)
    }
  }

  const handleDateRangeComplete = () => {
    setDateRangeReady(true)
  }

  const renderGroupList = () => (
    <div className="group-sidebar" style={{ width: sidebarWidth }}>
      <div className="sidebar-header">
        <div className="search-row">
          <div className="search-box">
            <Search size={16} />
            <input
              type="text"
              placeholder="搜索群聊..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button className="close-search" onClick={() => setSearchQuery('')}>
                <X size={12} />
              </button>
            )}
          </div>
          <button className="refresh-btn" onClick={loadGroups} disabled={isLoading}>
            <RefreshCw size={16} className={isLoading ? 'spin' : ''} />
          </button>
        </div>
      </div>
      <div className="group-list">
        {isLoading ? (
          <div className="loading-groups">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="skeleton-item">
                <div className="skeleton-avatar" />
                <div className="skeleton-content">
                  <div className="skeleton-line" />
                  <div className="skeleton-line" />
                </div>
              </div>
            ))}
          </div>
        ) : filteredGroups.length === 0 ? (
          <div className="empty-groups">
            <Users size={48} />
            <p>{searchQuery ? '未找到匹配的群聊' : '暂无群聊数据'}</p>
          </div>
        ) : (
          filteredGroups.map(group => (
            <div
              key={group.username}
              className={`group-item ${selectedGroupId === group.username ? 'active' : ''}`}
              onClick={() => handleGroupSelect(group)}
            >
              <div className="group-avatar">
                <Avatar src={group.avatarUrl} name={group.displayName} size={44} />
              </div>
              <div className="group-info">
                <span className="group-name">{group.displayName}</span>
                <span className="group-id">{group.username}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )


  const renderFunctionMenu = () => (
    <div className="function-menu">
      <div className="selected-group-info">
        <div className="group-avatar large">
          <Avatar src={selectedGroup?.avatarUrl} name={selectedGroup?.displayName} size={80} />
        </div>
        <div className="selected-group-meta">
          <span className="group-summary-label">已选择群聊</span>
          <h2>{selectedGroup?.displayName}</h2>
          <p>{selectedGroup?.username}</p>
        </div>
      </div>
      <div className="function-grid">
        <div className="function-card" onClick={() => handleFunctionSelect('ranking')}>
          <BarChart3 size={32} />
          <span>群聊发言排行</span>
          <small>统计发言数量排行</small>
        </div>
        <div className="function-card" onClick={() => handleFunctionSelect('activeHours')}>
          <Clock size={32} />
          <span>群聊活跃时段</span>
          <small>查看全天活跃时间分布</small>
        </div>
        <div className="function-card" onClick={() => handleFunctionSelect('mediaStats')}>
          <Image size={32} />
          <span>媒体内容统计</span>
          <small>统计文本、图片、语音等类型</small>
        </div>
      </div>
    </div>
  )

  const renderFunctionContent = () => {
    const getFunctionTitle = () => {
      switch (selectedFunction) {
        case 'ranking': return '群聊发言排行'
        case 'activeHours': return '群聊活跃时段'
        case 'mediaStats': return '媒体内容统计'
        default: return ''
      }
    }

    return (
      <div className="function-content">
        <div className="content-header">
          <button className="back-btn" onClick={() => setSelectedFunction(null)}>
            <ChevronLeft size={20} />
          </button>
          <div className="header-info">
            <h3>{getFunctionTitle()}</h3>
            <span className="header-subtitle">{selectedGroup?.displayName}</span>
          </div>
          {selectedFunction && (
            <DateRangePicker
              startDate={startDate}
              endDate={endDate}
              onStartDateChange={setStartDate}
              onEndDateChange={setEndDate}
              onRangeComplete={handleDateRangeComplete}
            />
          )}
          <button className="refresh-btn" onClick={handleRefresh} disabled={functionLoading}>
            <RefreshCw size={16} className={functionLoading ? 'spin' : ''} />
          </button>
        </div>
        <div className="content-body">
          {functionLoading ? (
            <div className="content-loading"><Loader2 size={32} className="spin" /></div>
          ) : (
            <>
              {selectedFunction === 'ranking' && (
                <div className="rankings-list">
                  {rankings.map((item, index) => (
                    <div key={item.member.username} className="ranking-item">
                      <span className={`rank ${index < 3 ? 'top' : ''}`}>{index + 1}</span>
                      <div className="contact-avatar">
                        <Avatar src={item.member.avatarUrl} name={item.member.displayName} size={40} />
                        {index < 3 && <div className={`medal medal-${index + 1}`}><Medal size={10} /></div>}
                      </div>
                      <div className="contact-info">
                        <span className="contact-name">{item.member.displayName}</span>
                      </div>
                      <span className="message-count">{formatNumber(item.messageCount)} 条</span>
                    </div>
                  ))}
                </div>
              )}
              {selectedFunction === 'activeHours' && (
                <div className="chart-container">
                  <ReactECharts option={getHourlyOption()} style={{ height: '100%', minHeight: 300 }} />
                </div>
              )}
              {selectedFunction === 'mediaStats' && mediaStats && (
                <div className="media-stats">
                  <div className="media-layout">
                    <div className="chart-container">
                      <ReactECharts option={getMediaOption()} style={{ height: '100%', minHeight: 300 }} />
                    </div>
                    <div className="media-legend">
                      {mediaStats.typeCounts.map(item => {
                        const colorMap: Record<number, string> = {
                          1: '#3b82f6', 3: '#22c55e', 34: '#f97316',
                          43: '#a855f7', 47: '#ec4899', 49: '#14b8a6', [-1]: '#6b7280'
                        }
                        const percentage = mediaStats.total > 0 ? ((item.count / mediaStats.total) * 100).toFixed(1) : '0'
                        return (
                          <div key={item.type} className="legend-item">
                            <span className="legend-color" style={{ backgroundColor: colorMap[item.type] || '#6b7280' }} />
                            <span className="legend-name">{item.name}</span>
                            <span className="legend-count">{formatNumber(item.count)} 条</span>
                            <span className="legend-percent">({percentage}%)</span>
                          </div>
                        )
                      })}
                      <div className="legend-total">
                        <span>总计</span>
                        <span>{formatNumber(mediaStats.total)} 条</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    )
  }


  const renderDetailPanel = () => {
    if (selectedFunction) {
      return renderFunctionContent()
    }

    if (!selectedGroup) {
      return (
        <>
          <div className="detail-drag-region" aria-hidden="true" />
          <div className="placeholder">
            <Users size={64} />
          <p>请从左侧选择一个群聊进行分析</p>
          </div>
        </>
      )
    }
    return (
      <>
        <div className="detail-drag-region" aria-hidden="true" />
        {renderFunctionMenu()}
      </>
    )
  }

  return (
    <div className="group-analytics-shell">
      <ChatAnalysisHeader currentMode="group" />
      <div className={`group-analytics-page ${isResizing ? 'resizing' : ''}`} ref={containerRef}>
        {renderGroupList()}
        <div className="resize-handle" onMouseDown={() => setIsResizing(true)} />
        <div className="detail-area">
          {renderDetailPanel()}
        </div>
      </div>
    </div>
  )
}

export default GroupAnalyticsPage
