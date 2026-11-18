<script setup lang="ts">
import { ref } from 'vue'
import type { Device, OsHint, ProtocolId } from '../../../shared/types'

const props = defineProps<{ devices: Device[]; loading?: boolean }>()
const emit = defineEmits<{
  (e: 'connect', device: Device): void
  (e: 'file-transfer', device: Device): void
  (e: 'refresh'): void
}>()

const viewMode = ref<'card' | 'table'>('card')

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

function recommend(device: Device): ProtocolId {
  return device.availableProtocols[0] ?? (device.osHint === 'windows' ? 'rdp' : 'vnc')
}

function displayName(device: Device): string {
  return device.name || device.ip
}

function formatTime(value: string): string {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}
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
        <el-button size="small" @click="emit('refresh')">刷新</el-button>
      </div>
    </div>

    <el-empty v-if="!props.loading && props.devices.length === 0" description="暂无设备，先扫描局域网或在设置中手动添加 IP">
      <el-button type="primary" @click="emit('refresh')">重新加载</el-button>
    </el-empty>

    <div v-else-if="viewMode === 'card'" class="card-grid">
      <article v-for="device in props.devices" :key="device.id" class="device-card">
        <div class="card-top">
          <div class="device-title">
            <span class="status-dot" :class="{ online: device.online }" />
            <strong :title="displayName(device)">{{ displayName(device) }}</strong>
          </div>
          <span class="ld-tag" :class="osTagClass[device.osHint]">{{ osLabels[device.osHint] }}</span>
        </div>
        <div class="device-ip">{{ device.ip }}</div>
        <div class="device-meta ld-muted">
          <span>{{ device.online ? '在线' : '离线/未扫描到' }}</span>
          <span>·</span>
          <span>来源 {{ device.source }}</span>
          <span v-if="device.mac">· {{ device.mac }}</span>
        </div>
        <div class="protocol-row">
          <span
            v-for="protocol in device.availableProtocols"
            :key="protocol"
            class="ld-tag"
          >{{ protocolLabels[protocol] }}</span>
          <span v-if="device.availableProtocols.length === 0" class="ld-tag muted">未探测到开放端口</span>
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

    <el-table v-else :data="props.devices" stripe style="width: 100%" max-height="460">
      <el-table-column prop="name" label="设备名" min-width="140" />
      <el-table-column prop="ip" label="IP 地址" width="140" />
      <el-table-column label="系统" width="110">
        <template #default="scope">
          <span class="ld-tag" :class="osTagClass[(scope.row as Device).osHint]">
            {{ osLabels[(scope.row as Device).osHint] }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="scope">
          <span :class="(scope.row as Device).online ? 'text-online' : 'ld-muted'">
            {{ (scope.row as Device).online ? '在线' : '离线' }}
          </span>
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
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="scope">
          <el-button link type="primary" size="small" @click="emit('connect', scope.row as Device)">连接</el-button>
          <el-button link size="small" @click="emit('file-transfer', scope.row as Device)">传文件</el-button>
        </template>
      </el-table-column>
    </el-table>
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
</style>
