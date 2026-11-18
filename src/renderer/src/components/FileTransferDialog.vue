<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api, unwrap } from '../api'
import type { AppSettings, Device, OsHint } from '../../../shared/types'

const props = defineProps<{ device: Device | null; settings: AppSettings | null }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const visible = computed({
  get: () => props.device !== null,
  set: (value: boolean) => {
    if (!value) emit('close')
  }
})

const shareName = ref('')
const opening = ref(false)

const osLabels: Record<OsHint, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  fnos: '飞牛OS',
  unknown: '未知系统'
}

const previewPath = computed(() => {
  if (!props.device) return ''
  return shareName.value.trim() ? `\\\\${props.device.ip}\\${shareName.value.trim()}` : `\\\\${props.device.ip}`
})

const guide = computed<Record<OsHint, string>>(() => ({
  windows: 'Windows 被控端：确认已开启“网络发现”和“文件或打印机共享”，记住要访问的共享名。',
  macos: 'macOS 被控端：系统设置 → 通用 → 共享 → 打开“文件共享”，连接身份选 SMB，记住共享名。',
  linux: 'Linux 被控端：需运行 Samba 服务并配置共享目录后，才能通过 SMB 访问。',
  fnos: '飞牛OS 被控端：控制面板开启 SMB/文件服务，在“存储空间/共享文件夹”里查看共享名。',
  unknown: '被控端需开启系统自带的 SMB/文件共享服务，并确认共享名。'
}))

watch(
  () => props.device,
  (device) => {
    if (!device) return
    shareName.value = props.settings?.defaultShareName ?? ''
  }
)

async function handleOpen(): Promise<void> {
  const device = props.device
  if (!device) return
  opening.value = true
  try {
    const result = await unwrap(
      api.fileTransferOpen({
        ip: device.ip,
        share: shareName.value.trim(),
        hint: device.osHint
      })
    )
    ElMessage({ type: 'success', message: result.message, duration: 9000 })
    visible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    opening.value = false
  }
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="文件传输（SMB 共享）"
    width="540px"
    :close-on-click-modal="false"
    align-center
  >
    <div v-if="props.device" class="ft-body">
      <div class="target-card">
        <div>
          <strong>{{ props.device.name || props.device.ip }}</strong>
          <div class="ld-muted target-ip">{{ props.device.ip }}</div>
        </div>
        <span class="ld-tag">系统：{{ osLabels[props.device.osHint] }}</span>
      </div>

      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="基于系统自带的文件共享，无需安装任何软件"
        description="本功能调用 Windows 资源管理器访问对端的 SMB 共享；LanDesk 不经手、不上传任何文件内容。"
      />

      <div class="field">
        <label>共享名（可选，留空则打开共享根目录）</label>
        <el-input v-model="shareName" placeholder="例如 shared / 共享文件夹" clearable />
        <p class="ld-muted field-hint">将打开：<code>{{ previewPath }}</code></p>
      </div>

      <div class="guide-box">
        <div class="guide-title">{{ osLabels[props.device.osHint] }} 被控端设置指引</div>
        <p>{{ guide[props.device.osHint] }}</p>
        <p>在弹出的资源管理器窗口输入被控端账号密码即可读写文件；也可把常用共享名填到“设置”里。</p>
      </div>

      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="仅连接已授权设备"
        description="访问共享需要被控端明确的账号授权；未经授权访问他人共享可能违法或违反单位规定。"
      />
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="opening" @click="handleOpen">打开共享文件夹</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.ft-body {
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
.field-hint {
  font-size: 11px;
  margin: 6px 0 0;
}
.field-hint code {
  background: #eef2f7;
  padding: 1px 5px;
  border-radius: 4px;
}
.guide-box {
  background: #f8fafc;
  border-radius: 8px;
  padding: 12px 14px;
  font-size: 12px;
  color: #526074;
}
.guide-title {
  font-weight: 700;
  margin-bottom: 6px;
}
.guide-box p {
  margin: 4px 0;
  line-height: 1.6;
}
</style>
