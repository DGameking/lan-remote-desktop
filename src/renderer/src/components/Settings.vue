<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, unwrap } from '../api'
import type { AppSettings, CredentialView, Device, ProtocolId } from '../../../shared/types'
import Diagnostics from './Diagnostics.vue'

const emit = defineEmits<{ (e: 'changed'): void }>()

const settings = ref<AppSettings>({
  vncViewerPath: '',
  rustdeskPath: '',
  useCmdkey: false,
  complianceAccepted: true,
  telemetryConsent: false,
  clipboardSharing: true,
  driveRedirection: false,
  defaultShareName: '',
  rdpScreenMode: 'adaptive',
  rdpWidth: 0,
  rdpHeight: 0,
  displayMode: 'fit',
  rdpPrinterRedirection: false,
  onlineRefreshEnabled: false,
  onlineRefreshIntervalSec: 60,
  autoScanIntervalMin: 0
})
const vncPath = ref('')
const rustdeskPath = ref('')
const defaultShareName = ref('')
const manualIp = ref('')
const manualName = ref('')
const credentials = ref<CredentialView[]>([])
const devices = ref<Device[]>([])
const saving = ref(false)
// v1.6: 数据备份
const includeSettings = ref(false)
const exporting = ref(false)
const importing = ref(false)

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
    defaultShareName.value = loadedSettings.defaultShareName ?? ''
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
        telemetryConsent: settings.value.telemetryConsent,
        clipboardSharing: settings.value.clipboardSharing,
        driveRedirection: settings.value.driveRedirection,
        defaultShareName: defaultShareName.value
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

/** v1.6: RDP 预设改动即保存（按字段 patch，沿用 settingsSet 合并语义）。 */
async function saveRdpPatch(patch: Partial<AppSettings>): Promise<void> {
  try {
    settings.value = await unwrap(api.settingsSet(patch))
    emit('changed')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

/**
 * v1.7: 在线状态与自动扫描改动即保存。
 * 传 rollback 是因为 :model-value 受控，写入失败需把本地值还原，否则界面与落盘不一致。
 */
async function saveOnlinePatch(
  patch: Partial<AppSettings>,
  rollback: Partial<AppSettings>
): Promise<void> {
  try {
    settings.value = await unwrap(api.settingsSet(patch))
    emit('changed')
  } catch (error) {
    settings.value = { ...settings.value, ...rollback }
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

/** v1.6: 导出设备与设置到用户选择的 JSON 文件（不含凭据）。 */
async function exportData(): Promise<void> {
  exporting.value = true
  try {
    const path = await unwrap(api.dataExport())
    ElMessage.success('已导出到 ' + path)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    exporting.value = false
  }
}

/** v1.6: 从用户选择的 JSON 文件导入，可只导入设备不带设置。 */
async function importData(): Promise<void> {
  importing.value = true
  try {
    const result = await unwrap(api.dataImport(includeSettings.value))
    ElMessage.success(
      `导入完成：新增 ${result.added} 项，更新 ${result.updated} 项，跳过 ${result.skipped} 项`
    )
    emit('changed')
    await load()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    importing.value = false
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
    detectedPorts: [],
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
        <el-switch v-model="settings.telemetryConsent" disabled />
        <span>允许匿名遥测（默认关闭，当前不生效）</span>
      </div>
      <p class="ld-muted telemetry-note">当前版本不采集、不上传任何遥测或诊断数据，此开关为未来版本预留，保持关闭。</p>
      <el-button type="primary" :loading="saving" @click="saveSettings">保存设置</el-button>
    </section>

    <section class="ld-panel">
      <h2>共享能力（默认值）</h2>
      <p class="ld-muted section-hint">这些是新建连接的默认开关，也可在连接对话框内临时调整。</p>
      <div class="switch-row">
        <el-switch v-model="settings.clipboardSharing" />
        <span>会话内共享剪贴板（RDP / 客户端原生能力）</span>
      </div>
      <div class="switch-row">
        <el-switch v-model="settings.driveRedirection" />
        <span>RDP 磁盘重定向（把本机磁盘映射进远程会话以传文件，建议仅对可信设备开启）</span>
      </div>
      <div class="field">
        <label>常用 SMB 共享名（可选）</label>
        <el-input v-model="defaultShareName" placeholder="例如 shared，点“传文件”时自动填入" clearable />
      </div>
      <el-button type="primary" :loading="saving" @click="saveSettings">保存设置</el-button>
    </section>

    <section class="ld-panel">
      <h2>显示与连接预设</h2>
      <p class="ld-muted section-hint">新建 RDP / VNC 连接的默认画面参数，可在连接对话框内临时调整；改动即时保存。</p>
      <div class="field">
        <label>显示模式（RDP / VNC 通用）</label>
        <el-select
          :model-value="settings.displayMode"
          placeholder="自适应当前屏幕"
          style="width: 100%"
          @update:model-value="saveRdpPatch({ displayMode: $event as AppSettings['displayMode'] })"
        >
          <el-option label="自动适应当前屏幕（推荐）" value="fit" />
          <el-option label="以远程原生分辨率显示" value="native" />
          <el-option label="固定分辨率（用下方宽高）" value="fixed" />
          <el-option label="全屏" value="fullscreen" />
        </el-select>
        <p class="ld-muted preset-hint">
          自适应：画面随本地窗口缩放；原生：保持远程分辨率、本地等比缩放；固定：会话强制为指定分辨率；全屏：连接即铺满当前屏幕。
        </p>
      </div>
      <div v-if="settings.displayMode === 'fixed'" class="field-grid">
        <div class="field">
          <label>会话宽度（像素）</label>
          <el-input-number
            :model-value="settings.rdpWidth"
            :min="640"
            :max="7680"
            controls-position="right"
            style="width: 100%"
            @change="saveRdpPatch({ rdpWidth: $event ?? 1920 })"
          />
        </div>
        <div class="field">
          <label>会话高度（像素）</label>
          <el-input-number
            :model-value="settings.rdpHeight"
            :max="4320"
            :min="480"
            controls-position="right"
            style="width: 100%"
            @change="saveRdpPatch({ rdpHeight: $event ?? 1080 })"
          />
        </div>
      </div>
      <p v-if="settings.displayMode === 'fixed'" class="ld-muted preset-hint">
        VNC 的固定分辨率需被控端服务端支持 SetDesktopSize，否则维持远程原分辨率；RDP 由客户端直接指定会话分辨率。
      </p>
      <div class="switch-row">
        <el-switch
          :model-value="settings.rdpPrinterRedirection"
          @change="saveRdpPatch({ rdpPrinterRedirection: $event as boolean })"
        />
        <span>默认开启打印机重定向（把本机打印机映射进远程会话）</span>
      </div>
    </section>

    <!-- v1.7: 在线状态与自动扫描 -->
    <section class="ld-panel wide">
      <h2>在线状态与自动扫描</h2>
      <p class="ld-muted section-hint">
        在线刷新会定时探测设备端口，状态变化才写盘；窗口失焦时自动降频。定时扫描会按间隔重新扫描主网段。改动即时保存。
      </p>
      <div class="switch-row">
        <el-switch
          :model-value="settings.onlineRefreshEnabled"
          @change="saveOnlinePatch({ onlineRefreshEnabled: !!$event }, { onlineRefreshEnabled: settings.onlineRefreshEnabled })"
        />
        <span>开启设备在线状态定时刷新（默认关闭，避免无谓流量）</span>
      </div>
      <div class="field-grid">
        <div class="field">
          <label>在线刷新间隔（秒，15–3600）</label>
          <el-input-number
            :model-value="settings.onlineRefreshIntervalSec"
            :min="15"
            :max="3600"
            :step="15"
            controls-position="right"
            style="width: 100%"
            @change="saveOnlinePatch({ onlineRefreshIntervalSec: $event ?? 15 }, { onlineRefreshIntervalSec: settings.onlineRefreshIntervalSec })"
          />
        </div>
        <div class="field">
          <label>定时扫描间隔（分钟，0=关闭）</label>
          <el-input-number
            :model-value="settings.autoScanIntervalMin"
            :min="0"
            :max="1440"
            controls-position="right"
            style="width: 100%"
            @change="saveOnlinePatch({ autoScanIntervalMin: $event ?? 0 }, { autoScanIntervalMin: settings.autoScanIntervalMin })"
          />
        </div>
      </div>
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
        <li>扫描只在本机进行，不上传任何设备信息；当前版本零遥测。</li>
        <li>不存储被控画面、键盘记录、剪贴板内容或传输的文件；日志仅保留最近 30 天。</li>
        <li>剪贴板与文件传输均由系统/客户端原生能力提供，LanDesk 不读取、不缓存其内容。</li>
        <li>共享剪贴板与磁盘重定向请仅在可信设备间开启；VNC 为明文协议，请仅在可信局域网使用。</li>
      </ul>
      <el-button plain @click="resetCompliance">重新显示首次合规声明</el-button>
    </section>

    <section class="ld-panel wide">
      <h2>数据备份（导入 / 导出）</h2>
      <p class="ld-muted section-hint">
        导出设备列表与设置到 JSON 文件，便于迁移或备份。凭据不会导出/导入（DPAPI 绑定本机本用户，密文在别处无法解密）。
      </p>
      <div class="backup-row">
        <el-button :loading="exporting" @click="exportData">导出设备与设置</el-button>
        <div class="backup-import">
          <el-switch v-model="includeSettings" />
          <span>同时导入设置（关闭则只导入设备）</span>
        </div>
        <el-button :loading="importing" @click="importData">导入设备与设置</el-button>
      </div>
      <p class="ld-muted backup-note">导入时按设备 ID 合并：新设备新增，已存在设备更新，非法或冲突记录跳过；统计结果会在导入完成后显示。</p>
    </section>

    <section class="ld-panel wide">
      <h2>运行状态与诊断</h2>
      <p class="ld-muted section-hint">查看软件运行状态、检索本机日志；导出诊断包后可复制脱敏文本交给 AI 排查问题。所有数据仅留本机，零遥测。</p>
      <Diagnostics />
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
.preset-hint {
  font-size: 12px;
  margin: 6px 0 12px;
  line-height: 1.6;
}
.field {
  margin-bottom: 14px;
}
.field-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.backup-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
}
.backup-import {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.backup-note {
  font-size: 12px;
  margin: 12px 0 0;
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
.telemetry-note {
  font-size: 12px;
  margin: 0 0 10px;
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
