<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api, unwrap } from '../api'
import type {
  DiagnosticsSnapshot,
  LatencyRecord,
  LogEntry,
  LogQuery,
  ProtocolId,
  SessionStatus
} from '../../../shared/types'

type RecentSession = DiagnosticsSnapshot['recentSessions'][number]
type LogLevel = LogEntry['level']

const snapshot = ref<DiagnosticsSnapshot | null>(null)
const loading = ref(false)
const exporting = ref(false)
const copying = ref(false)
const querying = ref(false)

/** 最近一次导出的诊断文本，供「复制诊断文本」复用 */
const exportedText = ref('')

const logs = ref<LogEntry[]>([])
const logQueried = ref(false)

// v1.7: 延迟测速历史（最近 100 条，本地留存）
const latencyRecords = ref<LatencyRecord[]>([])
const latencyLoading = ref(false)
const latencyLoaded = ref(false)

const levelOptions: LogLevel[] = ['INFO', 'WARN', 'ERROR']
const queryLevels = ref<LogLevel[]>([])
const queryModule = ref('')
const queryTraceId = ref('')
const queryKeyword = ref('')
const queryLimit = ref(200)

const protocolLabels: Record<ProtocolId, string> = {
  rdp: 'RDP',
  vnc: 'VNC',
  rustdesk: 'RustDesk'
}
const sessionStatusLabels: Record<SessionStatus, string> = {
  idle: '空闲',
  connecting: '连接中',
  connected: '已调起',
  failed: '失败',
  ended: '已结束'
}
const sessionStatusClass: Record<SessionStatus, string> = {
  idle: 'muted',
  connecting: '',
  connected: 'success',
  failed: 'danger',
  ended: 'muted'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatTime(value: string): string {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const parts: string[] = []
  if (days) parts.push(`${days} 天`)
  if (hours) parts.push(`${hours} 小时`)
  if (minutes) parts.push(`${minutes} 分`)
  parts.push(`${secs} 秒`)
  return parts.join(' ')
}

function formatContext(row: LogEntry): string {
  if (!row.context) return '-'
  try {
    return JSON.stringify(row.context)
  } catch {
    return '-'
  }
}

function levelTagType(level: LogLevel): 'danger' | 'warning' | 'info' {
  return level === 'ERROR' ? 'danger' : level === 'WARN' ? 'warning' : 'info'
}

async function load(): Promise<void> {
  loading.value = true
  try {
    snapshot.value = await unwrap(api.appGetDiagnostics())
  } catch (error) {
    ElMessage.error(errorText(error))
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
  void loadLatency()
})

/** v1.7: 拉取最近 100 条延迟测速记录（不传 IP 即全部）。 */
async function loadLatency(): Promise<void> {
  latencyLoading.value = true
  try {
    latencyRecords.value = await unwrap(api.latencyList())
    latencyLoaded.value = true
  } catch (error) {
    ElMessage.error(errorText(error))
  } finally {
    latencyLoading.value = false
  }
}

async function handleExport(): Promise<void> {
  exporting.value = true
  try {
    const result = await unwrap(api.appExportDiagnostics())
    exportedText.value = result.text
    ElMessage.success({
      message: `诊断包已导出到本机：${result.filePath}；可将该文件直接交给 AI，或点击「复制诊断文本」粘贴排查`,
      duration: 6000
    })
  } catch (error) {
    ElMessage.error(errorText(error))
  } finally {
    exporting.value = false
  }
}

async function copyText(): Promise<void> {
  copying.value = true
  try {
    if (!exportedText.value) {
      const result = await unwrap(api.appExportDiagnostics())
      exportedText.value = result.text
    }
    await navigator.clipboard.writeText(exportedText.value)
    ElMessage.success('诊断文本已复制到剪贴板，可粘贴给 AI 协助排查')
  } catch (error) {
    ElMessage.error(errorText(error))
  } finally {
    copying.value = false
  }
}

async function queryLogs(): Promise<void> {
  querying.value = true
  try {
    const query: LogQuery = { limit: queryLimit.value || 200 }
    if (queryLevels.value.length > 0) query.levels = [...queryLevels.value]
    const module = queryModule.value.trim()
    if (module) query.module = module
    const traceId = queryTraceId.value.trim()
    if (traceId) query.traceId = traceId
    const keyword = queryKeyword.value.trim()
    if (keyword) query.keyword = keyword
    logs.value = await unwrap(api.logQuery(query))
    logQueried.value = true
  } catch (error) {
    ElMessage.error(errorText(error))
  } finally {
    querying.value = false
  }
}
</script>

<template>
  <div class="diagnostics">
    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="零遥测 · 数据仅留本机"
      description="软件零遥测：所有状态与日志仅保存在本机，不会自动上传。点击「导出诊断包」后，主进程会把诊断文件写到本机 userData/diagnostics/ 固定路径，并返回可复制的脱敏文本；只有你手动点击导出或复制、并主动把文件或文本提交出去，信息才会离开这台电脑。"
    />

    <div class="action-bar">
      <el-button size="small" :loading="loading" @click="load">刷新</el-button>
      <el-button size="small" type="primary" :loading="exporting" @click="handleExport">导出诊断包</el-button>
      <el-button size="small" :loading="copying" @click="copyText">复制诊断文本</el-button>
      <el-button size="small" :loading="querying" @click="queryLogs">查询日志</el-button>
      <span class="ld-muted action-hint">导出会写入本机 userData/diagnostics/ 并生成可复制文本；复制后可直接粘贴给 AI 排查问题。</span>
    </div>

    <div v-if="snapshot" class="ld-muted generated-at">快照生成于 {{ formatTime(snapshot?.generatedAt || '') }}</div>
    <div v-if="!snapshot" class="ld-muted empty-hint">
      {{ loading ? '正在读取运行状态…' : '暂无运行状态数据，点击「刷新」重试。' }}
    </div>

    <template v-if="snapshot">
      <h3 class="block-title">应用与运行环境</h3>
      <el-descriptions :column="3" border size="small">
        <el-descriptions-item label="版本">{{ snapshot?.app.version }}</el-descriptions-item>
        <el-descriptions-item label="平台">{{ snapshot?.app.platform }}</el-descriptions-item>
        <el-descriptions-item label="架构">{{ snapshot?.app.arch }}</el-descriptions-item>
        <el-descriptions-item label="Electron 版本">{{ snapshot?.app.electronVersion }}</el-descriptions-item>
        <el-descriptions-item label="运行时长">{{ formatUptime(snapshot?.app.uptimeSeconds ?? 0) }}</el-descriptions-item>
        <el-descriptions-item label="存储模式">{{ snapshot?.app.storeMode === 'sqlite' ? 'SQLite' : 'JSON 降级' }}</el-descriptions-item>
        <el-descriptions-item label="安全存储">{{ snapshot?.app.safeStorageAvailable ? '可用' : '不可用' }}</el-descriptions-item>
        <el-descriptions-item label="网段（已脱敏）">{{ snapshot?.app.subnetRedacted }}</el-descriptions-item>
        <el-descriptions-item label="当前会话状态">
          <span class="ld-tag" :class="sessionStatusClass[snapshot?.sessionState ?? 'idle']">
            {{ sessionStatusLabels[snapshot?.sessionState ?? 'idle'] }}
          </span>
        </el-descriptions-item>
      </el-descriptions>

      <h3 class="block-title">数据概览</h3>
      <el-descriptions :column="4" border size="small">
        <el-descriptions-item label="设备">{{ snapshot?.counts.devices }}</el-descriptions-item>
        <el-descriptions-item label="凭据">{{ snapshot?.counts.credentials }}</el-descriptions-item>
        <el-descriptions-item label="会话">{{ snapshot?.counts.sessions }}</el-descriptions-item>
        <el-descriptions-item label="日志文件">{{ snapshot?.counts.logFiles }}</el-descriptions-item>
      </el-descriptions>

      <h3 class="block-title">外部客户端 / 协议</h3>
      <div class="tag-row">
        <el-tag
          v-for="item in snapshot?.protocols || []"
          :key="item.id"
          :type="item.available ? 'success' : 'info'"
          size="small"
          effect="light"
        >{{ protocolLabels[item.id] }} · {{ item.available ? '可用' : '未安装' }}</el-tag>
        <span v-if="(snapshot?.protocols || []).length === 0" class="ld-muted">暂无协议检测结果</span>
      </div>

      <h3 class="block-title">设置状态（均为脱敏后的开关）</h3>
      <div class="tag-row">
        <el-tag size="small" effect="plain" type="info">合规声明：{{ snapshot?.settings.complianceAccepted ? '已确认' : '未确认' }}</el-tag>
        <el-tag size="small" effect="plain" :type="snapshot?.settings.telemetryConsent ? 'warning' : 'success'">遥测：{{ snapshot?.settings.telemetryConsent ? '已开启' : '关闭' }}</el-tag>
        <el-tag size="small" effect="plain" type="info">剪贴板共享：{{ snapshot?.settings.clipboardSharing ? '开' : '关' }}</el-tag>
        <el-tag size="small" effect="plain" type="info">磁盘重定向：{{ snapshot?.settings.driveRedirection ? '开' : '关' }}</el-tag>
        <el-tag size="small" effect="plain" type="info">VNC Viewer 路径：{{ snapshot?.settings.hasVncViewerPath ? '已配置' : '自动探测' }}</el-tag>
        <el-tag size="small" effect="plain" type="info">RustDesk 路径：{{ snapshot?.settings.hasRustdeskPath ? '已配置' : '自动探测' }}</el-tag>
        <el-tag size="small" effect="plain" type="info">常用共享名：{{ snapshot?.settings.hasDefaultShareName ? '已配置' : '未配置' }}</el-tag>
      </div>

      <h3 class="block-title">最近一次扫描</h3>
      <div v-if="snapshot?.lastScan" class="ld-muted scan-line">
        网段（已脱敏）{{ snapshot?.lastScan?.subnetRedacted }} · 发现设备 {{ snapshot?.lastScan?.deviceCount }} 台 · 完成于 {{ formatTime(snapshot?.lastScan?.finishedAt || '') }}
      </div>
      <div v-else class="ld-muted scan-line">本次启动尚未完成扫描</div>

      <h3 class="block-title">近期会话</h3>
      <el-table :data="snapshot?.recentSessions || []" size="small" stripe style="width: 100%" max-height="220">
        <el-table-column label="时间" min-width="170">
          <template #default="scope">{{ formatTime((scope.row as RecentSession).startedAt) }}</template>
        </el-table-column>
        <el-table-column label="协议" width="100">
          <template #default="scope">{{ protocolLabels[(scope.row as RecentSession).protocol] }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="scope">
            <span class="ld-tag" :class="sessionStatusClass[(scope.row as RecentSession).status]">
              {{ sessionStatusLabels[(scope.row as RecentSession).status] }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="消息（已脱敏）" min-width="220">
          <template #default="scope">
            <span class="ld-muted">{{ (scope.row as RecentSession).errorMessageRedacted || '-' }}</span>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="(snapshot?.recentSessions || []).length === 0" description="暂无近期会话" :image-size="50" />

      <h3 class="block-title">近期错误</h3>
      <el-table :data="snapshot?.recentErrors || []" size="small" stripe style="width: 100%" max-height="220">
        <el-table-column label="时间" min-width="170">
          <template #default="scope">{{ formatTime((scope.row as LogEntry).ts) }}</template>
        </el-table-column>
        <el-table-column label="级别" width="80">
          <template #default="scope">
            <el-tag :type="levelTagType((scope.row as LogEntry).level)" size="small">{{ (scope.row as LogEntry).level }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="模块" width="140">
          <template #default="scope">{{ (scope.row as LogEntry).module }}</template>
        </el-table-column>
        <el-table-column label="消息（已脱敏）" min-width="220">
          <template #default="scope">
            <span class="ld-muted">{{ (scope.row as LogEntry).event }}</span>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="(snapshot?.recentErrors || []).length === 0" description="暂无近期错误" :image-size="50" />
    </template>

    <h3 class="block-title">日志查询</h3>
    <div class="log-query">
      <div class="query-field">
        <label>级别</label>
        <el-select
          v-model="queryLevels"
          multiple
          collapse-tags
          collapse-tags-tooltip
          clearable
          placeholder="全部级别"
          size="small"
          style="width: 100%"
        >
          <el-option v-for="lv in levelOptions" :key="lv" :label="lv" :value="lv" />
        </el-select>
      </div>
      <div class="query-field">
        <label>模块</label>
        <el-input v-model="queryModule" size="small" placeholder="如 discovery" clearable />
      </div>
      <div class="query-field">
        <label>traceId</label>
        <el-input v-model="queryTraceId" size="small" placeholder="可选" clearable />
      </div>
      <div class="query-field">
        <label>关键字</label>
        <el-input v-model="queryKeyword" size="small" placeholder="事件文本关键字" clearable />
      </div>
      <div class="query-field">
        <label>条数</label>
        <el-input-number
          v-model="queryLimit"
          :min="1"
          :max="1000"
          size="small"
          controls-position="right"
          style="width: 100%"
        />
      </div>
      <div class="query-field query-action">
        <el-button type="primary" size="small" :loading="querying" @click="queryLogs">查询</el-button>
      </div>
    </div>
    <el-table :data="logs" size="small" stripe style="width: 100%" max-height="320">
      <el-table-column label="时间" min-width="170">
        <template #default="scope">{{ formatTime((scope.row as LogEntry).ts) }}</template>
      </el-table-column>
      <el-table-column label="级别" width="80">
        <template #default="scope">
          <el-tag :type="levelTagType((scope.row as LogEntry).level)" size="small">{{ (scope.row as LogEntry).level }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="模块" width="130" prop="module" />
      <el-table-column label="事件" min-width="180">
        <template #default="scope">{{ (scope.row as LogEntry).event }}</template>
      </el-table-column>
      <el-table-column label="traceId" width="150">
        <template #default="scope">
          <span class="ld-muted">{{ (scope.row as LogEntry).traceId || '-' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="context" min-width="220">
        <template #default="scope">
          <span class="ld-muted">{{ formatContext(scope.row as LogEntry) }}</span>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="logQueried && logs.length === 0" description="无匹配日志" :image-size="50" />

    <h3 class="block-title">延迟测速历史（最近 100 条）</h3>
    <div class="latency-toolbar">
      <el-button size="small" :loading="latencyLoading" @click="loadLatency">刷新</el-button>
      <span class="ld-muted action-hint">测速结果仅保存在本机，零遥测。</span>
    </div>
    <el-table :data="latencyRecords" size="small" stripe style="width: 100%" max-height="320">
      <el-table-column label="目标 IP" min-width="150">
        <template #default="scope">{{ (scope.row as LatencyRecord).ip }}</template>
      </el-table-column>
      <el-table-column label="端口" width="90">
        <template #default="scope">{{ (scope.row as LatencyRecord).port }}</template>
      </el-table-column>
      <el-table-column label="延迟 ms" width="110">
        <template #default="scope">
          <span :class="(scope.row as LatencyRecord).reachable ? 'text-online' : 'ld-muted'">
            {{ (scope.row as LatencyRecord).latencyMs }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="结果" width="100">
        <template #default="scope">
          <el-tag :type="(scope.row as LatencyRecord).reachable ? 'success' : 'danger'" size="small">
            {{ (scope.row as LatencyRecord).reachable ? '可达' : '不可达' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="时间" min-width="170">
        <template #default="scope">{{ formatTime((scope.row as LatencyRecord).measuredAt) }}</template>
      </el-table-column>
    </el-table>
    <el-empty
      v-if="latencyLoaded && latencyRecords.length === 0"
      description="暂无测速记录"
      :image-size="50"
    />
  </div>
</template>

<style scoped>
.diagnostics {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.action-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.action-hint {
  font-size: 12px;
}
.latency-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.text-online {
  color: var(--ld-success);
}
.empty-hint {
  font-size: 12px;
  padding: 4px 0;
}
.generated-at {
  font-size: 12px;
}
.block-title {
  margin: 4px 0 0;
  font-size: 13px;
  font-weight: 700;
  color: #334155;
}
.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.scan-line {
  font-size: 12px;
}
.log-query {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
  align-items: end;
  background: #f8fafc;
  border: 1px solid var(--ld-border);
  border-radius: 10px;
  padding: 12px;
}
.query-field label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
.query-action {
  display: flex;
  align-items: flex-end;
}
</style>
