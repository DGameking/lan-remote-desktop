<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api, unwrap } from '../api'
import { defaultPortFor, parseTarget } from '../quick-connect'
import {
  CAPABILITY_MATRIX,
  type ConnectRequest,
  type ProtocolAvailability,
  type ProtocolId
} from '../../../shared/types'

const props = defineProps<{ visible: boolean; protocols: ProtocolAvailability[] }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'connected'): void
  (e: 'update:visible', value: boolean): void
}>()

const visible = computed({
  get: () => props.visible,
  set: (value: boolean) => {
    emit('update:visible', value)
    if (!value) emit('close')
  }
})

const target = ref('')
const ip = ref('')
const protocol = ref<ProtocolId>('rdp')
const port = ref<number | undefined>(defaultPortFor('rdp'))
/** 用户是否手动改过端口（手动指定后不再被协议切换覆盖） */
const portManuallySet = ref(false)
const username = ref('')
const password = ref('')
const rustdeskId = ref('')
const clipboardSharing = ref(true)
const driveRedirection = ref(false)
const agreed = ref(false)
const connecting = ref(false)

const protocolLabels: Record<ProtocolId, string> = {
  rdp: 'RDP（Windows）',
  vnc: 'VNC（macOS / Linux / 飞牛OS）',
  rustdesk: 'RustDesk（可选）'
}

const caps = computed(() => CAPABILITY_MATRIX[protocol.value])

function availability(id: ProtocolId): ProtocolAvailability | undefined {
  return props.protocols.find((item) => item.id === id)
}

// 打开时重置为干净状态，避免上一次输入残留
watch(
  () => props.visible,
  (open) => {
    if (!open) return
    target.value = ''
    ip.value = ''
    protocol.value = 'rdp'
    port.value = defaultPortFor('rdp')
    portManuallySet.value = false
    username.value = ''
    password.value = ''
    rustdeskId.value = ''
    clipboardSharing.value = true
    driveRedirection.value = false
    // 合规勾选按已确认设置回填，已确认过的用户无需每次重勾
    void loadCompliance()
    connecting.value = false
  }
)

async function loadCompliance(): Promise<void> {
  try {
    const settings = await unwrap(api.settingsGet())
    agreed.value = settings.complianceAccepted
    clipboardSharing.value = settings.clipboardSharing
    driveRedirection.value = settings.driveRedirection
  } catch {
    agreed.value = false
  }
}

// 输入变化时智能解析并回填 IP / 端口 / 协议提示；并尝试带出该 IP 已保存的账号
watch(target, (value) => {
  const parsed = parseTarget(value)
  if (!parsed) return
  ip.value = parsed.ip
  if (parsed.protocolHint) {
    protocol.value = parsed.protocolHint
  }
  if (parsed.port !== undefined) {
    port.value = parsed.port
    portManuallySet.value = true
  } else {
    portManuallySet.value = false
    port.value = defaultPortFor(protocol.value)
  }
  void prefillCredential(parsed.ip, protocol.value)
})

// 若该 IP + 协议已保存过凭据，回填用户名（密码不入 UI，由主进程按 deviceId 解密回填）
async function prefillCredential(targetIp: string, proto: ProtocolId): Promise<void> {
  try {
    const deviceId = 'quick-' + targetIp.replace(/\./g, '-')
    const list = await unwrap(api.credentialList())
    const saved = list.find((item) => item.deviceId === deviceId && item.protocol === proto)
    if (saved) username.value = saved.username
  } catch {
    // 凭据读取失败不阻断输入
  }
}

// 协议变化时，若端口未被手动指定则预填该协议默认端口，并尝试带出该协议的已存账号
watch(protocol, (value) => {
  if (!portManuallySet.value) {
    port.value = defaultPortFor(value)
  }
  if (ip.value) void prefillCredential(ip.value, value)
})

function onPortChange(): void {
  portManuallySet.value = true
}

async function handleConnect(): Promise<void> {
  const parsed = parseTarget(target.value)
  if (!parsed) {
    ElMessage.warning('请输入合法的 IP 或 IP:端口，例如 192.168.1.20 或 192.168.1.20:5900。')
    return
  }
  if (!agreed.value) {
    ElMessage.warning('请先勾选合规声明，确认仅连接自己有权访问的设备。')
    return
  }

  connecting.value = true
  try {
    const current = protocol.value
    const request: ConnectRequest = {
      deviceId: 'quick-' + parsed.ip.replace(/\./g, '-'),
      ip: parsed.ip,
      protocol: current,
      port: current === 'vnc' ? (port.value || 5900) : (port.value || undefined),
      username: username.value || undefined,
      password: password.value || undefined,
      rustdeskId: rustdeskId.value || undefined,
      clipboardSharing: clipboardSharing.value,
      driveRedirection: current === 'rdp' ? driveRedirection.value : undefined
    }
    const result = await unwrap(api.sessionConnect(request))
    if (!result.ok) {
      ElMessage.error(result.message)
      return
    }
    // 自动保存账号密码：与快速连接的 deviceId 一致，下次输入同一 IP 即可免密直连。
    // RustDesk 凭据由官方客户端管理，不入库；仅账号密码都填写时保存。
    if (
      current !== 'rustdesk' &&
      username.value &&
      password.value
    ) {
      try {
        await unwrap(
          api.credentialSet({
            deviceId: request.deviceId,
            protocol: current,
            username: username.value,
            password: password.value
          })
        )
      } catch {
        // 凭据保存失败不阻断已成功的连接
      }
    }
    const capText = result.capabilities?.length ? `\n${result.capabilities.join('；')}` : ''
    ElMessage({ type: 'success', message: result.message + capText, duration: 8000 })
    emit('connected')
    visible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    connecting.value = false
  }
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="快速连接（通用 IP:端口）"
    width="560px"
    :close-on-click-modal="false"
    align-center
  >
    <div class="connect-body">
      <div class="field">
        <label>目标地址</label>
        <el-input
          v-model="target"
          placeholder="输入 IP 或 IP:端口，例如 192.168.1.20 或 192.168.1.20:5900"
          clearable
          autocomplete="off"
        />
        <p class="ld-muted field-hint">
          支持纯 IPv4 或 IP:端口；端口 3389 自动识别为 RDP，5900-5910 识别为 VNC。
        </p>
        <p v-if="ip" class="ld-muted field-hint">解析目标：{{ ip }}</p>
      </div>

      <div class="field-grid">
        <div class="field">
          <label>连接协议</label>
          <el-select v-model="protocol" style="width: 100%">
            <el-option
              v-for="item in props.protocols"
              :key="item.id"
              :label="protocolLabels[item.id]"
              :value="item.id"
            >
              <div class="protocol-option">
                <span>{{ protocolLabels[item.id] }}</span>
                <span :class="item.available ? 'text-online' : 'ld-muted'" class="option-detail">
                  {{ item.available ? '可用' : '未安装' }}
                </span>
              </div>
            </el-option>
          </el-select>
          <p v-if="availability(protocol) && !availability(protocol)!.available" class="ld-muted field-hint">
            {{ availability(protocol)!.detail }}
          </p>
        </div>
        <div class="field">
          <label>端口（可选）</label>
          <el-input-number
            v-model="port"
            :min="1"
            :max="65535"
            controls-position="right"
            style="width: 100%"
            placeholder="留空使用协议默认端口"
            @change="onPortChange"
          />
        </div>
      </div>

      <div v-if="protocol === 'rustdesk'" class="field">
        <label>RustDesk 设备 ID（留空则使用 IP）</label>
        <el-input v-model="rustdeskId" placeholder="可选，例如 123456789" clearable />
      </div>

      <template v-if="protocol !== 'rustdesk'">
        <div class="field-grid">
          <div class="field">
            <label>用户名（可选）</label>
            <el-input v-model="username" placeholder="被控端账号" clearable autocomplete="off" />
          </div>
          <div class="field">
            <label>密码（可选）</label>
            <el-input
              v-model="password"
              type="password"
              placeholder="留空则在客户端中手输"
              show-password
              autocomplete="new-password"
            />
          </div>
        </div>
      </template>

      <!-- 共享能力区 -->
      <div class="capability-box">
        <div class="capability-title">本次会话的共享能力</div>
        <div class="cap-row">
          <div class="cap-info">
            <span class="cap-name">共享剪贴板</span>
            <span class="ld-muted cap-note">{{ caps.clipboard.note }}</span>
          </div>
          <el-switch
            v-if="caps.clipboard.supported"
            v-model="clipboardSharing"
            size="small"
            :disabled="protocol === 'vnc' || protocol === 'rustdesk'"
          />
          <span v-else class="ld-tag muted">不支持</span>
        </div>
        <div class="cap-row">
          <div class="cap-info">
            <span class="cap-name">文件传输</span>
            <span class="ld-muted cap-note">{{ caps.fileTransfer.note }}</span>
          </div>
          <el-switch v-if="protocol === 'rdp'" v-model="driveRedirection" size="small" />
          <span v-else-if="caps.fileTransfer.supported" class="ld-tag">客户端内</span>
          <span v-else class="ld-tag muted">用 SMB 通道</span>
        </div>
        <p v-if="protocol === 'rdp' && driveRedirection" class="cap-warning">
          注意：磁盘重定向开启后，被控端可访问你本机映射的磁盘。仅对可信设备开启。
        </p>
      </div>

      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="合规确认（每次连接需确认）"
        description="我确认仅连接自己拥有或已获得明确授权的设备，并遵守所在网络与单位的使用规范。"
      >
        <template #default>
          <el-checkbox v-model="agreed" style="margin-top: 8px">
            我已阅读并同意仅连接自己拥有或已获授权的设备
          </el-checkbox>
        </template>
      </el-alert>
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="connecting" @click="handleConnect">发起连接</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.connect-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.field label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
.field-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.field-hint {
  font-size: 11px;
  margin: 6px 0 0;
}
.capability-box {
  background: #f8fafc;
  border: 1px solid var(--ld-border);
  border-radius: 10px;
  padding: 12px 14px;
}
.capability-title {
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 8px;
}
.cap-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
  border-top: 1px dashed var(--ld-border);
}
.cap-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cap-name {
  font-size: 12px;
  font-weight: 600;
}
.cap-note {
  font-size: 11px;
  line-height: 1.5;
}
.cap-warning {
  font-size: 11px;
  color: #b45309;
  background: #fffbeb;
  border-radius: 6px;
  padding: 6px 8px;
  margin: 8px 0 0;
}
.protocol-option {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.option-detail {
  font-size: 12px;
}
.text-online {
  color: var(--ld-success);
}
</style>
