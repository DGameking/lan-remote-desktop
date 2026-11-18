<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api, unwrap } from '../api'
import {
  CAPABILITY_MATRIX,
  type Device,
  type PrecheckResult,
  type ProtocolAvailability,
  type ProtocolId
} from '../../../shared/types'

const props = defineProps<{ device: Device | null; protocols: ProtocolAvailability[] }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'connected'): void
}>()

const visible = computed({
  get: () => props.device !== null,
  set: (value: boolean) => {
    if (!value) emit('close')
  }
})

const protocol = ref<ProtocolId>('rdp')
const username = ref('')
const password = ref('')
const remember = ref(false)
const rustdeskId = ref('')
const clipboardSharing = ref(true)
const driveRedirection = ref(false)
const agreed = ref(false)
const connecting = ref(false)
const prechecking = ref(false)
const precheck = ref<PrecheckResult | null>(null)

const protocolLabels: Record<ProtocolId, string> = {
  rdp: 'RDP（Windows）',
  vnc: 'VNC（macOS / Linux / 飞牛OS）',
  rustdesk: 'RustDesk（可选）'
}

const caps = computed(() => CAPABILITY_MATRIX[protocol.value])

function availability(id: ProtocolId): ProtocolAvailability | undefined {
  return props.protocols.find((item) => item.id === id)
}

watch(
  () => props.device,
  (device) => {
    if (!device) return
    protocol.value = device.availableProtocols[0] ?? (device.osHint === 'windows' ? 'rdp' : 'vnc')
    username.value = ''
    password.value = ''
    remember.value = false
    rustdeskId.value = ''
    agreed.value = false
    precheck.value = null
  }
)

// 协议变化时同步共享开关默认值 + 重新预检
watch(protocol, () => {
  precheck.value = null
  void loadDefaultsAndPrecheck()
})

onMounted(() => {
  void loadDefaultsAndPrecheck()
})

async function loadDefaultsAndPrecheck(): Promise<void> {
  try {
    const settings = await unwrap(api.settingsGet())
    clipboardSharing.value = settings.clipboardSharing
    driveRedirection.value = settings.driveRedirection
    if (props.device && protocol.value !== 'rustdesk') {
      await runPrecheck()
    }
  } catch {
    // 设置读取失败不阻断连接对话框
  }
}

async function runPrecheck(): Promise<void> {
  const device = props.device
  if (!device) return
  prechecking.value = true
  try {
    precheck.value = await unwrap(
      api.sessionPrecheck(device.ip, protocol.value, protocol.value === 'vnc' ? 5900 : undefined)
    )
  } catch {
    precheck.value = null
  } finally {
    prechecking.value = false
  }
}

async function handleConnect(): Promise<void> {
  const device = props.device
  if (!device) return
  if (!agreed.value) {
    ElMessage.warning('请先勾选合规声明，确认仅连接自己有权访问的设备。')
    return
  }
  connecting.value = true
  try {
    if (remember.value && protocol.value !== 'rustdesk' && username.value) {
      await unwrap(
        api.credentialSet({
          deviceId: device.id,
          protocol: protocol.value,
          username: username.value,
          password: password.value
        })
      )
    }
    const result = await unwrap(
      api.sessionConnect({
        deviceId: device.id,
        ip: device.ip,
        protocol: protocol.value,
        port: protocol.value === 'vnc' ? 5900 : undefined,
        username: username.value || undefined,
        password: password.value || undefined,
        rustdeskId: rustdeskId.value || undefined,
        clipboardSharing: clipboardSharing.value,
        driveRedirection: protocol.value === 'rdp' ? driveRedirection.value : undefined
      })
    )
    if (!result.ok) {
      ElMessage.error(result.message)
      return
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
    title="连接远程设备"
    width="560px"
    :close-on-click-modal="false"
    align-center
  >
    <div v-if="props.device" class="connect-body">
      <div class="target-card">
        <div>
          <strong>{{ props.device.name || props.device.ip }}</strong>
          <div class="ld-muted target-ip">{{ props.device.ip }}</div>
        </div>
        <span class="ld-tag">系统：{{ props.device.osHint }}</span>
      </div>

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

      <!-- 连接前端口预检 -->
      <div v-if="precheck && precheck.port > 0" class="precheck-bar" :class="precheck.reachable ? 'ok' : 'bad'">
        <span class="precheck-dot" />
        <span v-if="precheck.reachable">
          端口 {{ precheck.port }} 可达 · 往返约 {{ precheck.latencyMs }} ms
        </span>
        <span v-else>
          端口 {{ precheck.port }} 未响应——请确认被控端已开启对应服务或检查防火墙
        </span>
        <el-button link size="small" :loading="prechecking" @click="runPrecheck">重新检测</el-button>
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
          <el-switch
            v-if="protocol === 'rdp'"
            v-model="driveRedirection"
            size="small"
          />
          <span v-else-if="caps.fileTransfer.supported" class="ld-tag">客户端内</span>
          <span v-else class="ld-tag muted">用 SMB 通道</span>
        </div>
        <p v-if="protocol === 'rdp' && driveRedirection" class="cap-warning">
          注意：磁盘重定向开启后，被控端可访问你本机映射的磁盘。仅对可信设备开启。
        </p>
      </div>

      <div class="notice">
        <p v-if="protocol === 'rdp'">
          RDP 密码<b>不会写入 .rdp 文件</b>，在 mstsc 窗口中手动输入最安全。
        </p>
        <p v-else-if="protocol === 'vnc'">
          VNC 协议使用明文传输风险较高，请仅在可信局域网使用；密码由 VNC Viewer 弹窗输入，不经命令行传递。
        </p>
        <p v-else>
          RustDesk 的剪贴板同步与文件传输由官方客户端原生提供，连接后在其窗口内使用。
        </p>
        <p v-if="protocol !== 'rustdesk'">
          <el-switch v-model="remember" size="small" :disabled="!username" />
          使用 DPAPI 加密保存凭据到本机（不存明文）
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
            我已阅读并同意上述合规声明
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
.target-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #f7faff;
  border: 1px solid var(--ld-border);
  border-radius: 10px;
  padding: 12px 14px;
}
.target-ip {
  font-size: 12px;
  margin-top: 2px;
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
.precheck-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 8px 12px;
  border-radius: 8px;
}
.precheck-bar.ok {
  background: #ecfdf5;
  color: #065f46;
}
.precheck-bar.bad {
  background: #fef2f2;
  color: #991b1b;
}
.precheck-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.precheck-bar .el-button {
  margin-left: auto;
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
.notice {
  background: #f8fafc;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12px;
  color: #526074;
}
.notice p {
  margin: 4px 0;
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
