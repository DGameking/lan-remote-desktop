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
  failed: '失败',
  ended: '已结束'
}
const statusClass: Record<SessionStatus, string> = {
  idle: 'muted',
  connecting: '',
  connected: 'success',
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
  <section class="ld-panel">
    <div class="history-head">
      <div>
        <h2>连接历史</h2>
        <p class="ld-muted">记录最近 200 次连接尝试。外部客户端一旦调起即记为“已调起”，本应用不接管远端会话的结束时刻。</p>
      </div>
      <div class="history-tools">
        <el-select v-model="protocolFilter" size="small" style="width: 120px" placeholder="全部协议">
          <el-option label="全部协议" value="" />
          <el-option label="RDP" value="rdp" />
          <el-option label="VNC" value="vnc" />
          <el-option label="RustDesk" value="rustdesk" />
        </el-select>
        <el-input v-model="keyword" size="small" placeholder="搜索设备名" clearable style="width: 180px" />
        <el-button size="small" @click="clearHistory">清空历史</el-button>
        <span class="ld-tag muted">共 {{ filteredRecords.length }} 条</span>
      </div>
    </div>
    <el-table :data="filteredRecords" stripe style="width: 100%" max-height="520">
      <el-table-column label="设备" min-width="150">
        <template #default="scope">{{ (scope.row as SessionRecord).deviceName }}</template>
      </el-table-column>
      <el-table-column label="协议" width="100">
        <template #default="scope">{{ protocolLabels[(scope.row as SessionRecord).protocol] }}</template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="scope">
          <span class="ld-tag" :class="statusClass[(scope.row as SessionRecord).status]">
            {{ statusLabels[(scope.row as SessionRecord).status] }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="时长" width="90">
        <template #default="scope">{{ durationText(scope.row as SessionRecord) }}</template>
      </el-table-column>
      <el-table-column label="发起时间" min-width="180">
        <template #default="scope">{{ formatTime((scope.row as SessionRecord).startedAt) }}</template>
      </el-table-column>
      <el-table-column label="结束时间" min-width="180">
        <template #default="scope">{{ formatTime((scope.row as SessionRecord).endedAt) }}</template>
      </el-table-column>
      <el-table-column label="错误信息" min-width="180">
        <template #default="scope">
          <span class="ld-muted error-text">{{ (scope.row as SessionRecord).errorMessage || '-' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="备注" min-width="180">
        <template #default="scope">
          <el-input
            v-model="noteDrafts[(scope.row as SessionRecord).id]"
            size="small"
            placeholder="添加备注，失焦保存"
            clearable
            maxlength="200"
            @blur="saveNote(scope.row as SessionRecord)"
          />
        </template>
      </el-table-column>
      <el-table-column label="操作" width="110" fixed="right">
        <template #default="scope">
          <el-button
            link
            type="primary"
            size="small"
            :loading="reconnectingId === (scope.row as SessionRecord).id"
            @click="reconnect(scope.row as SessionRecord)"
          >一键重连</el-button>
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
.history-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
}
h2 {
  margin: 0 0 4px;
  font-size: 18px;
}
.history-head p {
  margin: 0;
  font-size: 12px;
}
.history-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  flex-shrink: 0;
}
.error-text {
  font-size: 12px;
}
</style>
