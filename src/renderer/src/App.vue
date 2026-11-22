<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api, unwrap } from './api'
import type { AppSettings, AppStatus, Device, OsHint, ScanProgress, SubnetView } from '../../shared/types'
import ScanPanel from './components/ScanPanel.vue'
import DeviceList from './components/DeviceList.vue'
import ConnectDialog from './components/ConnectDialog.vue'
import QuickConnect from './components/QuickConnect.vue'
import FileTransferDialog from './components/FileTransferDialog.vue'
import Settings from './components/Settings.vue'
import History from './components/History.vue'

const activeTab = ref('devices')
const devices = ref<Device[]>([])
const appStatus = ref<AppStatus | null>(null)
const scanning = ref(false)
const progress = ref<ScanProgress>({
  phase: 'idle',
  percent: 0,
  message: '',
  subnet: '',
  devices: []
})
const selectedDevice = ref<Device | null>(null)
const quickConnectVisible = ref(false)
const transferDevice = ref<Device | null>(null)
const settings = ref<AppSettings | null>(null)
const complianceVisible = ref(false)
const complianceChecked = ref(false)
/** v1.4-A: 本机识别到的网段列表与用户当前选中的扫描目标 */
const subnets = ref<SubnetView[]>([])
const targetCidr = ref<string>('')

let unsubscribeProgress: (() => void) | null = null

async function refreshDevices(): Promise<void> {
  try {
    devices.value = await unwrap(api.deviceList())
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function refreshStatus(): Promise<void> {
  try {
    appStatus.value = await unwrap(api.appGetStatus())
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function refreshAll(): Promise<void> {
  await Promise.all([refreshDevices(), refreshStatus(), refreshSettings()])
}

/** v1.4-A: 拉取网段列表，默认选中主网段（虚拟网卡降权，UI 有标记）。 */
async function refreshSubnets(): Promise<void> {
  try {
    subnets.value = await unwrap(api.discoverySubnets())
    const primary = subnets.value.find((s) => s.isPrimary)
    const firstPhysical = subnets.value.find((s) => s.kind === 'physical')
    const chosen = primary ?? firstPhysical ?? subnets.value[0]
    if (chosen && !targetCidr.value) targetCidr.value = chosen.cidr
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

/** v1.4-B: 手动指定系统类型后回刷设备列表。 */
async function handleSetOs(device: Device, osHint: OsHint): Promise<void> {
  try {
    const updated = await unwrap(api.deviceSetOs(device.id, osHint))
    const index = devices.value.findIndex((item) => item.id === updated.id)
    if (index >= 0) devices.value[index] = updated
    ElMessage.success('系统类型已更新，后续扫描将保留此设置')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function refreshSettings(): Promise<void> {
  try {
    settings.value = await unwrap(api.settingsGet())
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function startScan(): Promise<void> {
  if (scanning.value) return
  scanning.value = true
  try {
    await unwrap(api.discoveryStart(targetCidr.value || undefined))
    await refreshDevices()
    ElMessage.success('扫描完成，设备列表已更新')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    scanning.value = false
  }
}

async function stopScan(): Promise<void> {
  try {
    await unwrap(api.discoveryStop())
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function confirmCompliance(): Promise<void> {
  if (!complianceChecked.value) {
    ElMessage.warning('请先勾选确认，仅连接自己有权访问的设备。')
    return
  }
  try {
    await unwrap(api.settingsSet({ complianceAccepted: true }))
    complianceVisible.value = false
    ElMessage.success('已确认合规声明')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

onMounted(async () => {
  unsubscribeProgress = api.onDiscoveryProgress((next) => {
    progress.value = next
    if (next.phase === 'done' || next.phase === 'stopped') scanning.value = false
  })
  await refreshAll()
  await refreshSubnets()
  try {
    const settings = await unwrap(api.settingsGet())
    if (!settings.complianceAccepted) complianceVisible.value = true
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
})

onUnmounted(() => {
  unsubscribeProgress?.()
})
</script>

<template>
  <div class="ld-page">
    <header class="app-header">
      <div class="brand">
        <div class="brand-mark">LD</div>
        <div>
          <h1>LanDesk</h1>
          <p>一台 Windows 电脑，集中掌控局域网内所有异构设备</p>
        </div>
      </div>
      <div class="header-status">
        <span class="ld-tag success">纯局域网 · 无服务端 · 无账号</span>
        <span v-if="appStatus" class="ld-tag muted">v{{ appStatus.version }} · {{ appStatus.storeMode === 'sqlite' ? 'SQLite' : 'JSON 降级' }}</span>
      </div>
    </header>

    <div class="protocol-strip" v-if="appStatus">
      <span class="strip-label">本机外部客户端：</span>
      <span
        v-for="item in appStatus.protocols"
        :key="item.id"
        class="ld-tag"
        :class="item.available ? 'success' : 'muted'"
        :title="item.detail"
      >{{ item.label }}{{ item.available ? ' 可用' : ' 未安装' }}</span>
      <span class="ld-tag muted">网段 {{ appStatus.subnet }}</span>
    </div>

    <main class="app-main">
      <el-tabs v-model="activeTab" class="ld-tabs">
        <el-tab-pane label="设备发现" name="devices">
          <div class="tab-content">
            <div class="quick-connect-bar">
              <el-button type="primary" plain @click="quickConnectVisible = true">
                快速连接（输入 IP:端口）
              </el-button>
              <span class="ld-muted quick-connect-hint">扫描不到设备？直接输入目标 IP 与端口即可发起连接。</span>
            </div>
            <ScanPanel
              :scanning="scanning"
              :progress="progress"
              :subnet="appStatus?.subnet || ''"
              :device-count="devices.length"
              :subnets="subnets"
              :target-cidr="targetCidr"
              @update:target-cidr="targetCidr = $event"
              @start="startScan"
              @stop="stopScan"
            />
            <DeviceList
              :devices="devices"
              :loading="scanning"
              @connect="selectedDevice = $event"
              @file-transfer="transferDevice = $event"
              @refresh="refreshDevices"
              @set-os="handleSetOs($event.device, $event.osHint)"
              @start-scan="startScan"
              @goto-settings="activeTab = 'settings'"
              @update-meta="refreshDevices"
            />
          </div>
        </el-tab-pane>
        <el-tab-pane label="连接历史" name="history">
          <div class="tab-content"><History /></div>
        </el-tab-pane>
        <el-tab-pane label="设置" name="settings">
          <div class="tab-content"><Settings @changed="refreshAll" /></div>
        </el-tab-pane>
      </el-tabs>
    </main>

    <footer class="app-footer ld-muted">
      LanDesk 仅调起本机已安装的外部客户端，不捆绑 GPL/AGPL 程序；请仅连接已授权设备。
    </footer>

    <QuickConnect
      v-model:visible="quickConnectVisible"
      :protocols="appStatus?.protocols || []"
      @connected="refreshAll"
    />

    <ConnectDialog
      :device="selectedDevice"
      :protocols="appStatus?.protocols || []"
      @close="selectedDevice = null"
      @connected="refreshAll"
    />

    <FileTransferDialog
      :device="transferDevice"
      :settings="settings"
      @close="transferDevice = null"
    />

    <el-dialog
      v-model="complianceVisible"
      title="使用前的合规声明"
      width="560px"
      :close-on-click-modal="false"
      :show-close="false"
      align-center
    >
      <div class="compliance-content">
        <el-alert
          type="warning"
          :closable="false"
          show-icon
          title="重要：请仅连接你有权访问的设备"
          description="本工具用于管理你自己拥有或已获得设备所有者明确授权的局域网设备。任何未经授权的访问、扫描或控制行为均可能违反法律与单位规定，责任由使用者自行承担。"
        />
        <ul>
          <li>扫描仅在本机局域网内进行，不上传设备信息，不需要公网或账号。</li>
          <li>VNC 采用明文传输，请仅在可信局域网使用；RDP 密码不写入 .rdp 文件。</li>
          <li>凭据使用 Windows DPAPI 加密后保存在本机，不存储明文密码。</li>
          <li>剪贴板共享与文件传输仅在会话内由系统原生能力提供，LanDesk 不读取其内容；请仅在可信设备间开启。</li>
        </ul>
        <el-checkbox v-model="complianceChecked">
          我已阅读并同意：仅连接自己拥有或已获明确授权的设备
        </el-checkbox>
      </div>
      <template #footer>
        <el-button type="primary" :disabled="!complianceChecked" @click="confirmCompliance">
          确认并进入
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.app-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 28px 12px;
  background: #fff;
  border-bottom: 1px solid var(--ld-border);
}
.brand {
  display: flex;
  align-items: center;
  gap: 14px;
}
.brand-mark {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: linear-gradient(135deg, #2563eb, #4f8df7);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 16px;
  letter-spacing: 0.5px;
}
.brand h1 {
  margin: 0;
  font-size: 20px;
  letter-spacing: 0.3px;
}
.brand p {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--ld-muted);
}
.header-status {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.protocol-strip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 28px;
  background: #f9fbff;
  border-bottom: 1px solid var(--ld-border);
}
.strip-label {
  font-size: 12px;
  color: var(--ld-muted);
  margin-right: 4px;
}
.app-main {
  flex: 1;
  min-height: 0;
  padding: 16px 28px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.ld-tabs {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.ld-tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.tab-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-bottom: 12px;
}
.quick-connect-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  background: #f7faff;
  border: 1px solid var(--ld-border);
  border-radius: 10px;
  padding: 10px 14px;
}
.quick-connect-hint {
  font-size: 12px;
}
.app-footer {
  padding: 8px 28px 14px;
  font-size: 11px;
  text-align: center;
}
.compliance-content ul {
  font-size: 13px;
  line-height: 1.9;
  color: #4b5769;
  padding-left: 20px;
  margin: 14px 0;
}
</style>
