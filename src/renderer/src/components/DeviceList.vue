<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api, unwrap } from '../api'
import {
  PROTOCOL_PRECHECK_PORT,
  type Device,
  type LatencyRecord,
  type OnlineStatusEvent,
  type OsConfidence,
  type OsHint,
  type ProtocolId
} from '../../../shared/types'

const props = defineProps<{ devices: Device[]; loading?: boolean }>()
const emit = defineEmits<{
  (e: 'connect', device: Device): void
  (e: 'file-transfer', device: Device): void
  (e: 'refresh'): void
  (e: 'set-os', payload: { device: Device; osHint: OsHint }): void
  (e: 'startScan'): void
  (e: 'gotoSettings'): void
  (e: 'updateMeta'): void
}>()

const viewMode = ref<'card' | 'table'>('card')

// v1.7: 多选批量唤醒
const selectedIps = ref<string[]>([])
const batchWaking = ref(false)

// v1.7: 在线状态变化推送订阅（收到事件只改本地对应设备的 online 字段，不重拉全量）
let unsubscribeOnline: (() => void) | null = null

// v1.7: 延迟测速结果（按 IP 保存最近一次），用于卡片/表格就地显示
const latencyMap = ref<Record<string, LatencyRecord>>({})
const measuring = ref<Record<string, boolean>>({})

// v1.6: 本地搜索 / 排序 / 分组筛选（纯前端，不触发扫描或 IPC）
const searchQuery = ref('')
const sortBy = ref<'default' | 'name' | 'ip' | 'recent'>('default')
const groupFilter = ref('')

const osLabels: Record<OsHint, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  fnos: '飞牛OS',
  unknown: '未知系统'
}
const osTagClass: Record<OsHint, string> = {
  windows: '',
  macos: 'success',
  linux: 'success',
  fnos: 'muted',
  unknown: 'muted'
}
const protocolLabels: Record<ProtocolId, string> = {
  rdp: 'RDP',
  vnc: 'VNC',
  rustdesk: 'RustDesk'
}

// v1.4-B: 置信度标签与识别依据展示
const confidenceLabels: Record<OsConfidence, string> = {
  high: '高',
  medium: '中',
  low: '低',
  none: '未识别'
}
const confidenceClass: Record<OsConfidence, string> = {
  high: 'conf-high',
  medium: 'conf-medium',
  low: 'conf-low',
  none: 'conf-none'
}
const osOptions: OsHint[] = ['windows', 'macos', 'linux', 'fnos', 'unknown']

function confidenceOf(device: Device): OsConfidence {
  return device.osConfidence ?? 'none'
}

function setOs(device: Device, cmd: unknown): void {
  if (!osOptions.includes(cmd as OsHint)) return
  emit('set-os', { device, osHint: cmd as OsHint })
}

function recommend(device: Device): ProtocolId {
  return device.availableProtocols[0] ?? (device.osHint === 'windows' ? 'rdp' : 'vnc')
}

/** v1.6: 有别名时优先显示别名，括号保留原名/扫描名，避免用户丢失来源信息。 */
function displayName(device: Device): string {
  const base = device.name || device.ip
  const alias = (device.alias ?? '').trim()
  return alias ? `${alias}（${base}）` : base
}

/** IP 按数值段比较，避免字符串排序把 192.168.1.100 排在 .20 之前。 */
function ipCompare(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 4; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 从所有设备的 group 去重生成筛选下拉选项（含空分组则忽略）。 */
const groupOptions = computed<string[]>(() => {
  const set = new Set<string>()
  props.devices.forEach((device) => {
    const group = (device.group ?? '').trim()
    if (group) set.add(group)
  })
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-CN'))
})

/** 过滤 + 排序：置顶优先 → 收藏优先 → 所选排序规则，全部本地 computed。 */
const visibleDevices = computed<Device[]>(() => {
  const kw = searchQuery.value.trim().toLowerCase()
  const group = groupFilter.value
  const list = props.devices.filter((device) => {
    if (group && (device.group ?? '').trim() !== group) return false
    if (!kw) return true
    return [device.name, device.ip, device.alias, device.group].some((field) =>
      (field ?? '').toLowerCase().includes(kw)
    )
  })
  return [...list].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
    if (!!a.favorite !== !!b.favorite) return a.favorite ? -1 : 1
    switch (sortBy.value) {
      case 'name':
        return displayName(a).localeCompare(displayName(b), 'zh-CN')
      case 'ip':
        return ipCompare(a.ip, b.ip)
      case 'recent':
        return new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()
      default:
        return 0
    }
  })
})

/** v1.6: 切换收藏/置顶；成功后让父组件刷新设备列表以持久化视图。 */
async function updateMeta(
  device: Device,
  patch: { favorite?: boolean; pinned?: boolean; alias?: string; group?: string },
  successMessage: string
): Promise<void> {
  try {
    await unwrap(api.deviceUpdateMeta({ deviceId: device.id, ...patch }))
    ElMessage.success(successMessage)
    emit('updateMeta')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

function toggleFavorite(device: Device): void {
  void updateMeta(device, { favorite: !device.favorite }, device.favorite ? '已取消收藏' : '已收藏')
}

function togglePinned(device: Device): void {
  void updateMeta(device, { pinned: !device.pinned }, device.pinned ? '已取消置顶' : '已置顶')
}

// 别名/分组编辑小表单
const editVisible = ref(false)
const editTarget = ref<Device | null>(null)
const editAlias = ref('')
const editGroup = ref('')

function openEdit(device: Device): void {
  editTarget.value = device
  editAlias.value = device.alias ?? ''
  editGroup.value = device.group ?? ''
  editVisible.value = true
}

async function submitEdit(): Promise<void> {
  const target = editTarget.value
  if (!target) return
  try {
    await unwrap(
      api.deviceUpdateMeta({
        deviceId: target.id,
        alias: editAlias.value.trim(),
        group: editGroup.value.trim()
      })
    )
    ElMessage.success('设备别名/分组已更新')
    editVisible.value = false
    emit('updateMeta')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

function formatTime(value: string): string {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

/** Web 管理页候选端口（按优先级）。URL 由主进程严格校验后生成并打开，不在渲染层拼装。 */
const SERVER_PORT_PRIORITY = [8000, 8001, 5666, 548, 5985, 5986]
const SERVER_LINK_TIP = '仅内网 IP + 已发现端口，由主进程校验后打开系统默认浏览器'
const WOL_TIP_LINES = [
  '远程唤醒（WoL）是 best-effort 的 UDP 广播魔术包，没有送达回执，无法确认设备是否真正开机。',
  '需被控端预先在 BIOS / 网卡开启 Wake-on-LAN，并连接网线（有线）。',
  '仅在同一网段（同一广播域）内有效。',
  '跨网段、经路由器转发或 Wi-Fi 无线连接通常无效。',
  '发送后请稍等片刻，再尝试扫描或连接。'
]

/** 仅返回该设备 discovered 端口中命中 Web 管理白名单的端口，按优先级排序。 */
function serverPorts(device: Device): number[] {
  const detected = device.detectedPorts ?? []
  return SERVER_PORT_PRIORITY.filter((port) => detected.includes(port))
}

async function openServer(device: Device, port: number): Promise<void> {
  try {
    const result = await unwrap(api.serverOpen({ ip: device.ip, port }))
    if (result.ok) ElMessage.success(result.message)
    else ElMessage.error(result.message)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function wakeDevice(device: Device): Promise<void> {
  try {
    const result = await unwrap(api.deviceWake({ mac: device.mac, ip: device.ip }))
    if (result.ok) ElMessage.success(result.message)
    else ElMessage.error(result.message)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

/* ============================ v1.7 新增 ============================ */

/** 卡片模式复选框：判断某 IP 是否已选中。 */
function isSelected(ip: string): boolean {
  return selectedIps.value.includes(ip)
}

/** 卡片模式复选框切换；表格模式由 el-table 的 selection-change 同步。 */
function setSelected(ip: string, checked: unknown): void {
  const next = new Set(selectedIps.value)
  if (checked) next.add(ip)
  else next.delete(ip)
  selectedIps.value = Array.from(next)
}

/** 表格模式 selection 列变化时把选中行 IP 同步到 shared 状态。 */
function onTableSelectionChange(rows: Device[]): void {
  selectedIps.value = rows.map((row) => row.ip)
}

/** 切换视图时清空选择，避免两种视图各自的选择状态不一致。 */
watch(viewMode, () => {
  selectedIps.value = []
})

/**
 * 批量唤醒：UI 循环调用现有 device:wake（不新增 IPC 通道）。
 * 单个失败不影响其它设备，最后汇总成功/失败/无 MAC 跳过数。
 */
async function batchWake(): Promise<void> {
  const targets = props.devices.filter((device) => selectedIps.value.includes(device.ip))
  if (targets.length === 0) return
  let ok = 0
  let failed = 0
  let noMac = 0
  batchWaking.value = true
  try {
    for (const device of targets) {
      if (!device.mac) {
        noMac++
        continue
      }
      try {
        const result = await unwrap(api.deviceWake({ mac: device.mac, ip: device.ip }))
        if (result.ok) ok++
        else failed++
      } catch {
        failed++
      }
    }
    const parts = [`唤醒 ${ok} 台`]
    if (failed > 0) parts.push(`失败 ${failed} 台`)
    if (noMac > 0) parts.push(`${noMac} 台无 MAC 跳过`)
    const message = parts.join('，')
    if (failed > 0) ElMessage.warning(message)
    else ElMessage.success(message)
  } finally {
    batchWaking.value = false
  }
}

/** 测速端口：优先用扫描发现的端口，否则用协议默认端口。 */
function latencyPort(device: Device): number {
  const detected = device.detectedPorts ?? []
  if (detected.length > 0) return detected[0]
  const defaultPort = PROTOCOL_PRECHECK_PORT[recommend(device)]
  return defaultPort > 0 ? defaultPort : 3389
}

/** 单台设备测速：成功后就地显示最近延迟，并提示 ms。 */
async function measureLatency(device: Device): Promise<void> {
  const port = latencyPort(device)
  measuring.value = { ...measuring.value, [device.ip]: true }
  try {
    const record = await unwrap(api.latencyMeasure(device.ip, port))
    latencyMap.value = { ...latencyMap.value, [device.ip]: record }
    if (record.reachable) ElMessage.success(`${device.ip}:${port} 延迟 ${record.latencyMs} ms`)
    else ElMessage.warning(`${device.ip}:${port} 不可达`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    const next = { ...measuring.value }
    delete next[device.ip]
    measuring.value = next
  }
}

/** 在线状态推送：只改 props 里对应设备的 online 字段（与父组件是同一响应式对象）。 */
onMounted(() => {
  unsubscribeOnline = api.onOnlineStatusChanged((event: OnlineStatusEvent) => {
    props.devices.forEach((device) => {
      if (device.ip === event.ip) device.online = event.online
    })
  })
})

onUnmounted(() => {
  unsubscribeOnline?.()
  unsubscribeOnline = null
})
</script>

<template>
  <div class="ld-panel">
    <div class="list-header">
      <div>
        <h2>设备列表 <span class="count">{{ props.devices.length }}</span></h2>
        <p class="ld-muted">在线状态来自最近一次扫描；可用协议依据开放端口自动推断。</p>
      </div>
      <div class="list-actions">
        <el-radio-group v-model="viewMode" size="small">
          <el-radio-button value="card">卡片</el-radio-button>
          <el-radio-button value="table">表格</el-radio-button>
        </el-radio-group>
        <el-button
          size="small"
          type="warning"
          plain
          :disabled="selectedIps.length === 0"
          :loading="batchWaking"
          @click="batchWake"
        >批量唤醒{{ selectedIps.length ? `（${selectedIps.length}）` : '' }}</el-button>
        <el-button size="small" @click="emit('refresh')">刷新</el-button>
      </div>
    </div>

    <!-- v1.6: 本地搜索 / 排序 / 分组筛选，不触发 IPC -->
    <div v-if="props.devices.length > 0" class="list-toolbar">
      <el-input
        v-model="searchQuery"
        size="small"
        clearable
        placeholder="搜索名称 / IP / 别名 / 分组"
        style="width: 230px"
      />
      <el-select v-model="sortBy" size="small" style="width: 130px">
        <el-option label="默认排序" value="default" />
        <el-option label="按名称" value="name" />
        <el-option label="按 IP" value="ip" />
        <el-option label="按最近发现" value="recent" />
      </el-select>
      <el-select v-model="groupFilter" size="small" style="width: 150px" placeholder="全部分组">
        <el-option label="全部分组" value="" />
        <el-option v-for="group in groupOptions" :key="group" :label="group" :value="group" />
      </el-select>
      <span class="ld-muted toolbar-count">显示 {{ visibleDevices.length }} / {{ props.devices.length }}</span>
    </div>

    <el-empty v-if="!props.loading && props.devices.length === 0" description="暂无设备，先扫描局域网或在设置中手动添加 IP">
      <div class="empty-actions">
        <el-button type="primary" @click="emit('startScan')">开始扫描</el-button>
        <el-button @click="emit('refresh')">刷新列表</el-button>
        <el-button plain @click="emit('gotoSettings')">手动添加设备</el-button>
      </div>
      <div class="empty-troubleshoot">
        <el-collapse>
          <el-collapse-item title="扫不到？三步排查" name="guide">
            <ol class="empty-guide-list">
              <li>确认被控机和本机连接在同一路由器 / 同一网段。</li>
              <li>确认被控端已开启远程桌面 / 屏幕共享 / VNC 服务。</li>
              <li>确认被控端防火墙已放行 3389（RDP）或 5900（VNC）端口。</li>
            </ol>
          </el-collapse-item>
        </el-collapse>
      </div>
    </el-empty>

    <div v-else-if="props.devices.length > 0 && visibleDevices.length === 0" class="filter-empty ld-muted">
      没有匹配的设备，试试调整搜索词或分组筛选。
    </div>

    <div v-else-if="viewMode === 'card'" class="card-grid">
      <article v-for="device in visibleDevices" :key="device.id" class="device-card">
        <div class="card-top">
          <el-checkbox
            class="card-select"
            :model-value="isSelected(device.ip)"
            @change="(checked: unknown) => setSelected(device.ip, checked)"
          />
          <div class="device-title">
            <span class="status-dot" :class="{ online: device.online }" />
            <strong :title="displayName(device)">{{ displayName(device) }}</strong>
          </div>
          <el-dropdown trigger="click" @command="(cmd: OsHint) => setOs(device, cmd)">
            <span class="ld-tag os-tag" :class="osTagClass[device.osHint]">
              {{ osLabels[device.osHint] }}
              <span class="conf-badge" :class="confidenceClass[confidenceOf(device)]">
                {{ device.osManual ? '手动' : confidenceLabels[confidenceOf(device)] }}
              </span>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item disabled>系统识别依据：</el-dropdown-item>
                <el-dropdown-item v-for="(e, i) in (device.osEvidence ?? [])" :key="i" disabled>
                  {{ e.detail }}
                </el-dropdown-item>
                <el-dropdown-item disabled divided>手动指定系统（扫描不再覆盖）：</el-dropdown-item>
                <el-dropdown-item
                  v-for="opt in osOptions"
                  :key="opt"
                  :command="opt"
                >{{ osLabels[opt] }}</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
        <!-- v1.6: 收藏 / 置顶 / 别名分组 -->
        <div class="meta-actions">
          <el-button link size="small" :type="device.favorite ? 'warning' : 'info'" @click="toggleFavorite(device)">
            {{ device.favorite ? '★ 已收藏' : '☆ 收藏' }}
          </el-button>
          <el-button link size="small" :type="device.pinned ? 'primary' : 'info'" @click="togglePinned(device)">
            {{ device.pinned ? '已置顶' : '置顶' }}
          </el-button>
          <el-button link size="small" @click="openEdit(device)">别名/分组</el-button>
        </div>
        <div class="device-ip">{{ device.ip }}</div>
        <div class="device-meta ld-muted">
          <span>{{ device.online ? '在线' : '离线/未扫描到' }}</span>
          <span>·</span>
          <span>来源 {{ device.source }}</span>
          <span v-if="latencyMap[device.ip]">· 最近延迟 {{ latencyMap[device.ip].latencyMs }} ms</span>
          <span v-if="device.mac">· {{ device.mac }}</span>
          <el-tag v-if="device.group" size="small" type="info" effect="plain" class="group-tag">{{ device.group }}</el-tag>
        </div>
        <div class="protocol-row">
          <span
            v-for="protocol in device.availableProtocols"
            :key="protocol"
            class="ld-tag"
          >{{ protocolLabels[protocol] }}</span>
          <span v-if="device.availableProtocols.length === 0" class="ld-tag muted">未探测到开放端口</span>
        </div>
        <div class="card-extra">
          <el-button
            size="small"
            plain
            :loading="!!measuring[device.ip]"
            @click="measureLatency(device)"
          >测速</el-button>
          <el-tooltip v-if="serverPorts(device).length === 1" :content="SERVER_LINK_TIP" placement="top">
            <el-button size="small" plain @click="openServer(device, serverPorts(device)[0])">管理页</el-button>
          </el-tooltip>
          <el-dropdown v-else-if="serverPorts(device).length > 1" trigger="click">
            <el-button size="small" plain>管理页（{{ serverPorts(device).length }}）▾</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-for="port in serverPorts(device)" :key="port" @click="openServer(device, port)">
                  端口 {{ port }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-tooltip v-if="device.mac" placement="top">
            <template #content>
              <div style="max-width: 300px; font-size: 12px; line-height: 1.7">
                <div v-for="(line, idx) in WOL_TIP_LINES" :key="idx">{{ line }}</div>
              </div>
            </template>
            <el-button size="small" plain @click="wakeDevice(device)">远程唤醒</el-button>
          </el-tooltip>
        </div>
        <div class="card-footer">
          <span class="ld-muted last-seen">最近发现 {{ formatTime(device.lastSeenAt) }}</span>
          <div class="footer-actions">
            <el-button size="small" plain @click="emit('file-transfer', device)">传文件</el-button>
            <el-button type="primary" size="small" @click="emit('connect', device)">
              {{ protocolLabels[recommend(device)] }}
            </el-button>
          </div>
        </div>
      </article>
    </div>

    <el-table
      v-else
      :data="visibleDevices"
      stripe
      style="width: 100%"
      max-height="460"
      @selection-change="onTableSelectionChange"
    >
      <el-table-column type="selection" width="42" />
      <el-table-column label="设备名" min-width="140">
        <template #default="scope">{{ displayName(scope.row as Device) }}</template>
      </el-table-column>
      <el-table-column label="分组" width="100">
        <template #default="scope">
          <el-tag v-if="(scope.row as Device).group" size="small" type="info" effect="plain">
            {{ (scope.row as Device).group }}
          </el-tag>
          <span v-else class="ld-muted">-</span>
        </template>
      </el-table-column>
      <el-table-column prop="ip" label="IP 地址" width="140" />
      <el-table-column label="系统 / 置信度" width="130">
        <template #default="scope">
          <el-dropdown trigger="click" @command="(cmd: unknown) => setOs(scope.row as Device, cmd)">
            <span class="ld-tag os-tag" :class="osTagClass[(scope.row as Device).osHint]">
              {{ osLabels[(scope.row as Device).osHint] }}
              <span class="conf-badge" :class="confidenceClass[confidenceOf(scope.row as Device)]">
                {{ (scope.row as Device).osManual ? '手动' : confidenceLabels[confidenceOf(scope.row as Device)] }}
              </span>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <template v-if="(scope.row as Device).osEvidence?.length">
                  <el-dropdown-item disabled>系统识别依据：</el-dropdown-item>
                  <el-dropdown-item
                    v-for="(e, i) in (scope.row as Device).osEvidence"
                    :key="i"
                    disabled
                  >{{ e.detail }}</el-dropdown-item>
                  <el-dropdown-item disabled divided>手动指定（扫描不再覆盖）：</el-dropdown-item>
                </template>
                <el-dropdown-item v-for="opt in osOptions" :key="opt" :command="opt">
                  {{ osLabels[opt] }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>
      </el-table-column>
      <el-table-column label="状态 / 最近延迟" width="130">
        <template #default="scope">
          <span :class="(scope.row as Device).online ? 'text-online' : 'ld-muted'">
            {{ (scope.row as Device).online ? '在线' : '离线' }}
          </span>
          <div v-if="latencyMap[(scope.row as Device).ip]" class="latency-text">
            延迟 {{ latencyMap[(scope.row as Device).ip].latencyMs }} ms
          </div>
        </template>
      </el-table-column>
      <el-table-column label="可用协议" min-width="150">
        <template #default="scope">
          <span
            v-for="protocol in (scope.row as Device).availableProtocols"
            :key="protocol"
            class="ld-tag"
          >{{ protocolLabels[protocol] }}</span>
          <span v-if="(scope.row as Device).availableProtocols.length === 0" class="ld-muted">-</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="510" fixed="right">
        <template #default="scope">
          <el-button link type="primary" size="small" @click="emit('connect', scope.row as Device)">连接</el-button>
          <el-button link size="small" @click="emit('file-transfer', scope.row as Device)">传文件</el-button>
          <el-button
            link
            size="small"
            :loading="!!measuring[(scope.row as Device).ip]"
            @click="measureLatency(scope.row as Device)"
          >测速</el-button>
          <el-button link size="small" :type="(scope.row as Device).favorite ? 'warning' : 'info'" @click="toggleFavorite(scope.row as Device)">
            {{ (scope.row as Device).favorite ? '★' : '☆' }}
          </el-button>
          <el-button link size="small" :type="(scope.row as Device).pinned ? 'primary' : 'info'" @click="togglePinned(scope.row as Device)">
            {{ (scope.row as Device).pinned ? '已置顶' : '置顶' }}
          </el-button>
          <el-button link size="small" @click="openEdit(scope.row as Device)">别名/分组</el-button>
          <el-tooltip v-if="serverPorts(scope.row as Device).length === 1" :content="SERVER_LINK_TIP" placement="top">
            <el-button link size="small" @click="openServer(scope.row as Device, serverPorts(scope.row as Device)[0])">管理页</el-button>
          </el-tooltip>
          <el-dropdown v-else-if="serverPorts(scope.row as Device).length > 1" trigger="click">
            <el-button link size="small">管理页▾</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-for="port in serverPorts(scope.row as Device)"
                  :key="port"
                  @click="openServer(scope.row as Device, port)"
                >
                  端口 {{ port }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-tooltip v-if="(scope.row as Device).mac" placement="top">
            <template #content>
              <div style="max-width: 300px; font-size: 12px; line-height: 1.7">
                <div v-for="(line, idx) in WOL_TIP_LINES" :key="idx">{{ line }}</div>
              </div>
            </template>
            <el-button link size="small" @click="wakeDevice(scope.row as Device)">远程唤醒</el-button>
          </el-tooltip>
        </template>
      </el-table-column>
    </el-table>

    <!-- v1.6: 编辑别名 / 分组 -->
    <el-dialog
      v-model="editVisible"
      title="编辑设备别名与分组"
      width="420px"
      align-center
      @closed="editTarget = null"
    >
      <div v-if="editTarget" class="edit-dialog">
        <p class="ld-muted edit-target">{{ editTarget.name || editTarget.ip }}（{{ editTarget.ip }}）</p>
        <div class="field">
          <label>别名（留空则使用原名）</label>
          <el-input v-model="editAlias" placeholder="例如 书房 NAS" clearable maxlength="40" />
        </div>
        <div class="field">
          <label>分组（留空则未分组）</label>
          <el-input v-model="editGroup" placeholder="例如 家庭 / 办公室" clearable maxlength="40" />
        </div>
      </div>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.list-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
}
.list-header h2 {
  margin: 0 0 4px;
  font-size: 18px;
}
.list-header p {
  margin: 0;
  font-size: 12px;
}
.count {
  font-size: 13px;
  font-weight: 500;
  color: var(--ld-primary);
  background: var(--ld-primary-soft);
  padding: 1px 8px;
  border-radius: 999px;
}
.list-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.list-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
}
.toolbar-count {
  font-size: 12px;
  margin-left: auto;
}
.filter-empty {
  font-size: 13px;
  padding: 24px;
  text-align: center;
}
.meta-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  margin-top: 6px;
}
.group-tag {
  margin-left: 4px;
}
.edit-dialog .field {
  margin-bottom: 14px;
}
.edit-dialog .field label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
.edit-target {
  font-size: 12px;
  margin: 0 0 14px;
}
.empty-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}
.empty-troubleshoot {
  width: 360px;
  max-width: 100%;
  margin: 14px auto 0;
  text-align: left;
}
.empty-guide-list {
  margin: 0;
  padding-left: 20px;
  font-size: 12px;
  line-height: 1.9;
  color: #526074;
}
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
}
.device-card {
  border: 1px solid var(--ld-border);
  border-radius: 12px;
  padding: 14px 16px;
  background: #fff;
  transition: box-shadow 0.18s ease, transform 0.18s ease;
}
.device-card:hover {
  box-shadow: 0 8px 22px rgba(37, 99, 235, 0.12);
  transform: translateY(-1px);
}
.card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.device-title {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.device-title strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #c3cbd8;
  flex-shrink: 0;
}
.status-dot.online {
  background: var(--ld-success);
  box-shadow: 0 0 0 3px rgba(22, 163, 74, 0.12);
}
.device-ip {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: 0.4px;
  margin: 12px 0 6px;
  font-variant-numeric: tabular-nums;
}
.device-meta {
  font-size: 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.protocol-row {
  margin: 12px 0;
  min-height: 24px;
}
.card-extra {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0 2px;
}
.card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  border-top: 1px dashed var(--ld-border);
  padding-top: 12px;
}
.footer-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.last-seen {
  font-size: 11px;
}
.text-online {
  color: var(--ld-success);
}
.card-select {
  flex-shrink: 0;
  margin-right: 2px;
}
.latency-text {
  font-size: 11px;
  color: var(--ld-primary);
  margin-top: 2px;
}
.os-tag {
  cursor: pointer;
}
.conf-badge {
  display: inline-block;
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 10px;
  line-height: 16px;
  font-weight: 600;
}
.conf-high {
  background: #16a34a;
  color: #fff;
}
.conf-medium {
  background: #2563eb;
  color: #fff;
}
.conf-low {
  background: #f59e0b;
  color: #fff;
}
.conf-none {
  background: #94a3b8;
  color: #fff;
}
</style>
