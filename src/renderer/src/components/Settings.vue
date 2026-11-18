<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, unwrap } from '../api'
import type { AppSettings, CredentialView, Device, ProtocolId } from '../../../shared/types'

const emit = defineEmits<{ (e: 'changed'): void }>()

const settings = ref<AppSettings>({
  vncViewerPath: '',
  rustdeskPath: '',
  useCmdkey: false,
  complianceAccepted: true,
  telemetryConsent: false
})
const vncPath = ref('')
const rustdeskPath = ref('')
const manualIp = ref('')
const manualName = ref('')
const credentials = ref<CredentialView[]>([])
const devices = ref<Device[]>([])
const saving = ref(false)

const protocolLabels: Record<ProtocolId, string> = {
  rdp: 'RDP',
  vnc: 'VNC',
  rustdesk: 'RustDesk'
}

function deviceName(id: string): string {
  return devices.value.find((device) => device.id === id)?.name || id
}

async function load(): Promise<void> {
  try {
    const [loadedSettings, loadedCredentials, loadedDevices] = await Promise.all([
      unwrap(api.settingsGet()),
      unwrap(api.credentialList()),
      unwrap(api.deviceList())
    ])
    settings.value = loadedSettings
    vncPath.value = loadedSettings.vncViewerPath
    rustdeskPath.value = loadedSettings.rustdeskPath
    credentials.value = loadedCredentials
    devices.value = loadedDevices
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

onMounted(() => {
  void load()
})

async function saveSettings(): Promise<void> {
  saving.value = true
  try {
    const updated = await unwrap(
      api.settingsSet({
        vncViewerPath: vncPath.value,
        rustdeskPath: rustdeskPath.value,
        useCmdkey: settings.value.useCmdkey,
        telemetryConsent: settings.value.telemetryConsent
      })
    )
    settings.value = updated
    ElMessage.success('设置已保存')
    emit('changed')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    saving.value = false
  }
}

async function addManualDevice(): Promise<void> {
  const ip = manualIp.value.trim()
  const parts = ip.split('.')
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    ElMessage.warning('请输入合法的 IPv4 地址，例如 192.168.1.20')
    return
  }
  const timestamp = new Date().toISOString()
  const device: Device = {
    id: `dev-${ip.replace(/\./g, '-')}`,
    name: manualName.value.trim() || ip,
    ip,
    mac: '',
    osHint: 'unknown',
    source: 'manual',
    availableProtocols: [],
    online: true,
    lastSeenAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  }
  try {
    await unwrap(api.deviceUpsert(device))
    ElMessage.success(`已添加设备 ${ip}`)
    manualIp.value = ''
    manualName.value = ''
    emit('changed')
    await load()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function removeCredential(id: string): Promise<void> {
  try {
    await ElMessageBox.confirm('确定删除这条已保存的凭据吗？', '删除凭据', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
    await unwrap(api.credentialDelete(id))
    ElMessage.success('凭据已删除')
    await load()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      ElMessage.error(error instanceof Error ? error.message : String(error))
    }
  }
}

async function resetCompliance(): Promise<void> {
  try {
    const updated = await unwrap(api.settingsSet({ complianceAccepted: false }))
    settings.value = updated
    ElMessage.success('合规声明已重置，下次启动将重新确认')
    emit('changed')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}
</script>

<template>
  <div class="settings-grid">
    <section class="ld-panel">
      <h2>外部客户端路径</h2>
      <p class="ld-muted section-hint">LanDesk 只调起本机已安装的客户端，不捆绑任何 GPL/AGPL 程序。</p>
      <div class="field">
        <label>VNC Viewer 路径</label>
        <el-input v-model="vncPath" placeholder="留空则自动探测 TigerVNC / RealVNC / TightVNC" clearable />
      </div>
      <div class="field">
        <label>RustDesk 路径（可选）</label>
        <el-input v-model="rustdeskPath" placeholder="留空则自动探测本机 RustDesk 客户端" clearable />
      </div>
      <div class="switch-row">
        <el-switch v-model="settings.useCmdkey" />
        <span>RDP 连接时允许用 Windows 凭据管理器预置账号（默认关闭）</span>
      </div>
      <div class="switch-row">
        <el-switch v-model="settings.telemetryConsent" />
        <span>允许匿名遥测（默认关闭，当前版本不上报任何数据）</span>
      </div>
      <el-button type="primary" :loading="saving" @click="saveSettings">保存设置</el-button>
    </section>

    <section class="ld-panel">
      <h2>手动添加设备</h2>
      <p class="ld-muted section-hint">多网卡 / AP 隔离导致扫描失败时，可直接输入 IP 添加。</p>
      <div class="field">
        <label>IP 地址</label>
        <el-input v-model="manualIp" placeholder="例如 192.168.1.20" clearable />
      </div>
      <div class="field">
        <label>设备备注名（可选）</label>
        <el-input v-model="manualName" placeholder="例如 书房 Mac mini" clearable />
      </div>
      <el-button type="primary" plain @click="addManualDevice">添加设备</el-button>
    </section>

    <section class="ld-panel wide">
      <h2>已保存凭据</h2>
      <p class="ld-muted section-hint">密码经 Windows DPAPI 加密后以密文落盘，界面永不显示明文。</p>
      <el-table :data="credentials" size="small" style="width: 100%">
        <el-table-column label="设备" min-width="160">
          <template #default="scope">{{ deviceName((scope.row as CredentialView).deviceId) }}</template>
        </el-table-column>
        <el-table-column label="协议" width="100">
          <template #default="scope">{{ protocolLabels[(scope.row as CredentialView).protocol] }}</template>
        </el-table-column>
        <el-table-column prop="username" label="用户名" min-width="140" />
        <el-table-column label="密码" width="90">
          <template #default="scope">
            <span :class="(scope.row as CredentialView).hasPassword ? 'text-online' : 'ld-muted'">
              {{ (scope.row as CredentialView).hasPassword ? '已加密保存' : '未保存' }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="scope">
            <el-button link type="danger" size="small" @click="removeCredential((scope.row as CredentialView).id)">
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="credentials.length === 0" description="暂无已保存凭据" :image-size="60" />
    </section>

    <section class="ld-panel wide">
      <h2>合规与隐私</h2>
      <ul class="privacy-list ld-muted">
        <li>仅连接自己拥有或已获明确授权的设备，禁止用于未授权访问。</li>
        <li>扫描只在本机进行，不上传任何设备信息；遥测默认关闭。</li>
        <li>不存储被控画面、键盘记录；日志仅保留最近 30 天。</li>
        <li>VNC 为明文协议，请仅在可信局域网使用。</li>
      </ul>
      <el-button plain @click="resetCompliance">重新显示首次合规声明</el-button>
    </section>
  </div>
</template>

<style scoped>
.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.settings-grid .wide {
  grid-column: 1 / -1;
}
h2 {
  margin: 0 0 6px;
  font-size: 16px;
}
.section-hint {
  font-size: 12px;
  margin: 0 0 16px;
}
.field {
  margin-bottom: 14px;
}
.field label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
.switch-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  margin: 10px 0;
}
.privacy-list {
  font-size: 12px;
  line-height: 1.9;
  margin: 0 0 12px;
  padding-left: 18px;
}
.text-online {
  color: var(--ld-success);
}
</style>
