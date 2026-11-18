<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api, unwrap } from '../api'
import type { Device, ProtocolAvailability, ProtocolId } from '../../../shared/types'

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
const useCmdkey = ref(false)
const agreed = ref(false)
const connecting = ref(false)

const protocolLabels: Record<ProtocolId, string> = {
  rdp: 'RDP（Windows）',
  vnc: 'VNC（macOS / Linux / 飞牛OS）',
  rustdesk: 'RustDesk（可选）'
}

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
  }
)

onMounted(() => {
  void unwrap(api.settingsGet())
    .then((settings) => {
      useCmdkey.value = settings.useCmdkey
    })
    .catch(() => undefined)
})

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
        useCmdkey: protocol.value === 'rdp' && useCmdkey.value
      })
    )
    if (!result.ok) {
      ElMessage.error(result.message)
      return
    }
    ElMessage({ type: 'success', message: result.message, duration: 6000 })
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
    width="540px"
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

        <div class="notice">
          <p v-if="protocol === 'rdp'">
            RDP 密码<b>不会写入 .rdp 文件</b>，在 mstsc 窗口中手动输入最安全。
          </p>
          <p v-else>
            VNC 协议使用明文传输风险较高，请仅在可信局域网使用；密码由 VNC Viewer 弹窗输入，不经命令行传递。
          </p>
          <p v-if="protocol === 'rdp' && username">
            <el-switch v-model="useCmdkey" size="small" /> 使用 Windows 凭据管理器预置（两分钟后自动清理）
          </p>
          <p>
            <el-switch v-model="remember" size="small" :disabled="!username" />
            使用 DPAPI 加密保存凭据到本机（不存明文）
          </p>
        </div>
      </template>

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
