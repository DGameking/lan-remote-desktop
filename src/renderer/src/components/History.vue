<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, unwrap } from '../api'
import type {
  ConnectRequest,
  Device,
  IpcResponse,
  ProtocolId,
  SessionRecord,
  SessionStatus
} from '../../../shared/types'

const records = ref<SessionRecord[]>([])
/** v1.5 P0-3: 设备索引，用于从历史记录（含 deviceId）还原 ip / 端口并发起重连 */
const devicesById = ref<Map<string, Device>>(new Map())
const protocolFilter = ref<'' | ProtocolId>('')
const statusFilter = ref<'' | SessionStatus>('')
const keyword = ref('')
const reconnectingId = ref<string | null>(null)
/** v1.6: 每行备注的本地草稿，blur 时提交；失败则还原为 record.note。 */
const noteDrafts = ref<Record<string, string>>({})

const protocolLabels: Record<ProtocolId, string> = {
  rdp: 'RDP',
  vnc: 'VNC',
  rustdesk: 'RustDesk'
}
const statusLabels: Record<SessionStatus, string> = {
  idle: '空闲',
  connecting: '连接中',
  connected: '已调起',
  failed: '未连上',
  ended: '已结束'
}
const statusClass: Record<SessionStatus, string> = {
  idle: 'muted',
  connecting: 'info',
  connected: 'info',
  failed: 'danger',
  ended: 'muted'
}

function formatTime(value: string): string {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

/** 不显示假的 0：不可测 → 不可测，有值 → Ns，否则 - */
function durationText(record: SessionRecord): string {
  if (record.durationUnavailable) return '不可测'
  if (typeof record.durationSec === 'number') return `${record.durationSec}s`
  return '-'
}

/** v1.6: 刷新历史后同步备注草稿。 */
function syncNoteDrafts(): void {
  const next: Record<string, string> = {}
  records.value.forEach((record) => {
    next[record.id] = record.note ?? ''
  })
  noteDrafts.value = next
}

/** v1.6: 失焦保存备注；无变化跳过，失败时还原输入框。 */
async function saveNote(record: SessionRecord): Promise<void> {
  const value = (noteDrafts.value[record.id] ?? '').trim()
  if (value === (record.note ?? '')) return
  try {
    await unwrap(api.sessionSetNote(record.id, value))
    record.note = value
    ElMessage.success('备注已保存')
  } catch (error) {
    noteDrafts.value[record.id] = record.note ?? ''
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

const filteredRecords = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return records.value.filter((record) => {
    if (protocolFilter.value && record.protocol !== protocolFilter.value) return false
    if (statusFilter.value && record.status !== statusFilter.value) return false
    if (!kw) return true
    return (
      (record.deviceName || '').toLowerCase().includes(kw) ||
      (record.deviceId || '').toLowerCase().includes(kw)
    )
  })
})

/** 与连接对话框一致：只从已发现端口推断真实端口，未发现则不传（让主进程用协议默认端口）。 */
function reconnectPort(device: Device, protocol: ProtocolId): number | undefined {
  const detected = device.detectedPorts ?? []
  if (protocol === 'vnc') return detected.find((p) => p >= 5900 && p <= 5910)
  if (protocol === 'rdp') return detected.includes(3389) ? 3389 : undefined
  return undefined
}

/** 一键重连：只用已存凭据（不传账号密码），让主进程免密直连。 */
async function reconnect(record: SessionRecord): Promise<void> {
  const device = devicesById.value.get(record.deviceId)
  if (!device) {
    ElMessage.warning('该设备不在当前列表中，请先在「设备发现」中扫描后再重连。')
    return
  }
  const request: ConnectRequest = {
    deviceId: device.id,
    ip: device.ip,
    protocol: record.protocol,
    port: reconnectPort(device, record.protocol)
  }
  reconnectingId.value = record.id
  try {
    const result = await unwrap(api.sessionConnect(request))
    if (!result.ok) {
      ElMessage.error(result.message || '重连失败')
      return
    }
    ElMessage.success(result.message || '已重新发起连接')
    // 刷新历史以呈现本次重连记录；失败分支保留原历史不动。
    records.value = await unwrap(api.sessionList())
    syncNoteDrafts()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    reconnectingId.value = null
  }
}

async function clearHistory(): Promise<void> {
  try {
    await ElMessageBox.confirm('确定要清空全部连接历史吗？此操作不可撤销。', '清空历史', {
      type: 'warning',
      confirmButtonText: '确定清空',
      cancelButtonText: '取消'
    })
  } catch {
    return // 用户取消
  }
  try {
    // sessionClear 契约已在 types.ts / preload / ipc 落地；用可选链兼容尚未落地的环境，避免崩溃。
    const clearFn = (api as unknown as { sessionClear?: () => Promise<IpcResponse<boolean>> }).sessionClear
    if (!clearFn) {
      ElMessage.warning('清空历史功能将在后续版本提供')
      return
    }
    await unwrap(clearFn())
    records.value = []
    ElMessage.success('连接历史已清空')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

onMounted(async () => {
  try {
    const [list, deviceList] = await Promise.all([unwrap(api.sessionList()), unwrap(api.deviceList())])
    records.value = list
    syncNoteDrafts()
    devicesById.value = new Map(deviceList.map((device) => [device.id, device]))
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
})
</script>

<template>
  <section class="ld-panel history-panel">
    <div class="history-head">
      <div class="history-title">
        <h2 class="ld-section-title">连接历史</h2>
        <p class="ld-section-subtitle">
          记录最近 200 次连接尝试。状态反映外部客户端的调起与退出；本工具不接管远端会话，
          <strong>“已调起”不等于已进入远程桌面</strong>。
        </p>
      </div>
      <div class="history-tools">
        <el-select v-model="protocolFilter" size="small" style="width: 116px" placeholder="全部协议">
          <el-option label="全部协议" value="" />
          <el-option label="RDP" value="rdp" />
          <el-option label="VNC" value="vnc" />
          <el-option label="RustDesk" value="rustdesk" />
        </el-select>
        <el-select v-model="statusFilter" size="small" style="width: 120px" placeholder="全部状态">
          <el-option label="全部状态" value="" />
          <el-option label="未连上" value="failed" />
          <el-option label="已调起" value="connected" />
          <el-option label="已结束" value="ended" />
        </el-select>
        <el-input v-model="keyword" size="small" placeholder="搜索设备 / IP" clearable style="width: 168px" />
        <el-button size="small" @click="clearHistory">清空历史</el-button>
        <span class="ld-tag muted count-badge">{{ filteredRecords.length }} 条</span>
      </div>
    </div>
    <el-table :data="filteredRecords" stripe style="width: 100%" max-height="560" row-key="id" class="history-table">
      <el-table-column label="设备 / 目标" min-width="150">
        <template #default="scope">
          <div class="device-cell">
            <span class="device-name">{{ (scope.row as SessionRecord).deviceName }}</span>
            <span class="device-ip ld-muted">{{ (scope.row as SessionRecord).ip || (scope.row as SessionRecord).deviceId }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="协议" width="92">
        <template #default="scope">
          <span class="protocol-badge">{{ protocolLabels[(scope.row as SessionRecord).protocol] }}</span>
        </template>
      </el-table-column>
      <el-table-column label="结果" width="106">
        <template #default="scope">
          <span class="ld-tag status-tag" :class="statusClass[(scope.row as SessionRecord).status]">
            <i class="ld-dot" aria-hidden="true" />
            {{ statusLabels[(scope.row as SessionRecord).status] }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="客户端运行" width="104">
        <template #default="scope">
          <span :class="(scope.row as SessionRecord).status === 'failed' ? 'duration-failed' : ''">
            {{ durationText(scope.row as SessionRecord) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="发起时间" min-width="164">
        <template #default="scope">{{ formatTime((scope.row as SessionRecord).startedAt) }}</template>
      </el-table-column>
      <el-table-column label="结束时间" min-width="164">
        <template #default="scope">{{ formatTime((scope.row as SessionRecord).endedAt) }}</template>
      </el-table-column>
      <el-table-column label="结果说明" min-width="230">
        <template #default="scope">
          <div v-if="(scope.row as SessionRecord).errorMessage" class="error-cell" :title="(scope.row as SessionRecord).errorMessage">
            <span class="error-icon" aria-hidden="true">!</span>
            <span class="error-text">{{ (scope.row as SessionRecord).errorMessage }}</span>
          </div>
          <span v-else class="ld-muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="备注" min-width="140">
        <template #default="scope">
          <el-input
            v-model="noteDrafts[(scope.row as SessionRecord).id]"
            size="small"
            placeholder="添加备注"
            clearable
            maxlength="200"
            @blur="saveNote(scope.row as SessionRecord)"
          />
        </template>
      </el-table-column>
      <el-table-column label="操作" width="100" fixed="right" align="center">
        <template #default="scope">
          <el-button
            link
            type="primary"
            size="small"
            :loading="reconnectingId === (scope.row as SessionRecord).id"
            @click="reconnect(scope.row as SessionRecord)"
          >重连</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-empty
      v-if="filteredRecords.length === 0"
      :description="records.length === 0 ? '还没有连接记录' : '没有匹配筛选条件的记录'"
    />
  </section>
</template>

<style scoped>
.history-panel {
  padding-bottom: 12px;
}
.history-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 20px;
  margin-bottom: 18px;
}
.history-title {
  max-width: 560px;
}
.history-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  flex-shrink: 0;
}
.count-badge {
  margin-right: 0;
}
.device-cell {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
}
.device-name {
  font-weight: 600;
  color: var(--ld-text);
}
.device-ip {
  font-size: 11px;
  margin-top: 2px;
}
.protocol-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--ld-bg-soft);
  color: var(--ld-text-secondary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.status-tag {
  margin-right: 0;
}
.duration-failed {
  color: var(--ld-danger);
  font-weight: 600;
}
.error-cell {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--ld-danger);
}
.error-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: var(--ld-danger);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  flex-shrink: 0;
  margin-top: 2px;
}
.error-text {
  font-size: 12px;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
