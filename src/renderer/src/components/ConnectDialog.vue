<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api, unwrap } from '../api'
import {
  CAPABILITY_MATRIX,
  SYSTEM_PROTOCOL_MATRIX,
  getSystemProtocolCapability,
  type Device,
  type PrecheckConclusion,
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
// 默认开启：输入账密即自动保存，下次点击同一设备免密直连（用户可手动关闭）
const remember = ref(true)
const rustdeskId = ref('')
const clipboardSharing = ref(true)
const driveRedirection = ref(false)
const agreed = ref(false)
const connecting = ref(false)
const prechecking = ref(false)
const precheck = ref<PrecheckResult | null>(null)
const precheckMessage = ref('')
const lastFailed = ref(false)
const activeTroubleshoot = ref<string[]>([])

const protocolLabels: Record<ProtocolId, string> = {
  rdp: 'RDP（Windows）',
  vnc: 'VNC（macOS / Linux / 飞牛OS）',
  rustdesk: 'RustDesk（可选）'
}

/** v1.5 P0-4: 预检结论的人话标签，避免只显示"通/不通"。 */
const conclusionLabels: Record<PrecheckConclusion, string> = {
  reachable: '可连接',
  offline: '设备不在线',
  port_closed: '服务端口未开',
  firewall_or_auth: '防火墙拦截或认证问题',
  unknown: '无法确定'
}

const caps = computed(() => CAPABILITY_MATRIX[protocol.value])

/**
 * v1.4-C: 系统×协议 能力矩阵提示。命中矩阵时剪贴板/文件传输的 note 以矩阵为准
 *（更贴合该系统的真实限制），否则保留 CAPABILITY_MATRIX 的协议级 note。
 */
const sysCaps = computed(() => {
  const device = props.device
  if (!device) return null
  const hit = SYSTEM_PROTOCOL_MATRIX[device.osHint]?.[protocol.value] !== undefined
  const sys = getSystemProtocolCapability(device.osHint, protocol.value)
  return {
    prerequisite: sys.prerequisite,
    clipboardNote: hit ? sys.clipboard.note : caps.value.clipboard.note,
    fileTransferNote: hit ? sys.fileTransfer.note : caps.value.fileTransfer.note
  }
})

/** 连接时实际使用的端口：VNC 优先扫描发现的显示号段，RDP 仅在发现 3389 时显式指定。 */
const connectionPort = computed<number | undefined>(() => {
  if (!props.device || protocol.value === 'rustdesk') return undefined
  const detected = props.device.detectedPorts ?? []
  if (protocol.value === 'vnc') {
    return detected.find((p) => p >= 5900 && p <= 5910) ?? 5900
  }
  if (protocol.value === 'rdp') {
    return detected.includes(3389) ? 3389 : undefined
  }
  return undefined
})

const detectedPortsLabel = computed(() => (props.device?.detectedPorts ?? []).join('、'))

/** 按当前协议给出的针对性排查项，连接失败时自动展开。 */
const troubleshooting = computed<{ title: string; items: string[] }[]>(() => {
  const common = [
    '确认目标设备 IP 填写正确，且主控端与被控端处于同一局域网。',
    '确认被控端电脑已开机且未进入休眠。'
  ]
  if (protocol.value === 'rdp') {
    return [
      {
        title: 'RDP 针对性检查',
        items: [
          '确认被控端为 Windows 专业版/企业版（家庭版默认不支持被远程桌面连接）。',
          '确认被控端已启用“允许远程连接到此计算机”（设置 → 系统 → 远程桌面）。',
          '确认被控端防火墙已放行 3389 端口（TCP）。',
          '确认用于连接的账户设置了密码（空密码账户默认不允许 RDP 登录）。'
        ]
      },
      { title: '通用检查', items: common }
    ]
  }
  if (protocol.value === 'vnc') {
    return [
      {
        title: 'VNC 针对性检查',
        items: [
          '确认被控端已开启屏幕共享/VNC 服务（macOS：系统设置 → 通用 → 共享 → 屏幕共享）。',
          '确认 VNC 连接密码正确，且允许来自主控端的连接。',
          '确认端口正确：若 VNC 运行在非 5900 端口（如 5901），请使用扫描发现的端口连接。'
        ]
      },
      { title: '通用检查', items: common }
    ]
  }
  return [
    {
      title: '通用检查',
      items: [...common, '确认 RustDesk 客户端已安装并在线，且设备 ID 填写正确。']
    }
  ]
})

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
    remember.value = true
    rustdeskId.value = ''
    // 合规勾选不硬重置：由 loadDefaultsAndPrecheck 按已确认设置回填，
    // 已确认过的用户不必每次连接都重勾（v1.3.0）。
    precheck.value = null
    precheckMessage.value = ''
    lastFailed.value = false
    activeTroubleshoot.value = []
    // 组件常驻挂载：首次打开某设备时协议可能未变化（如默认 RDP），
    // 因此必须在 device 变化时主动回填设置并触发预检，否则预检条永远不出现。
    void loadDefaultsAndPrecheck()
  }
)

// 协议变化时同步共享开关默认值 + 重新预检
watch(protocol, () => {
  precheck.value = null
  precheckMessage.value = ''
  lastFailed.value = false
  activeTroubleshoot.value = []
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
    agreed.value = settings.complianceAccepted
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
    const response = await api.sessionPrecheck(device.ip, protocol.value, connectionPort.value)
    if (response.code === 0 && response.data) {
      precheck.value = response.data
      precheckMessage.value = response.message === 'success' ? '' : response.message
    } else {
      precheck.value = null
      precheckMessage.value = response.message || '端口预检失败'
    }
  } catch (error) {
    precheck.value = null
    precheckMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    prechecking.value = false
  }
}

/** 把 ref 持有的响应式 PrecheckResult 展开成纯数据快照（Proxy 不能被 IPC 结构化克隆）。 */
function precheckSnapshot(value: PrecheckResult | null): PrecheckResult | undefined {
  if (!value) return undefined
  return {
    ip: value.ip,
    port: value.port,
    reachable: value.reachable,
    latencyMs: value.latencyMs,
    ...(value.skipped !== undefined ? { skipped: value.skipped } : {}),
    ...(value.conclusion !== undefined ? { conclusion: value.conclusion } : {}),
    ...(value.actions ? { actions: [...value.actions] } : {}),
    ...(value.icmpReachable !== undefined ? { icmpReachable: value.icmpReachable } : {})
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
  // 先连接、后保存：凭据保存失败绝不能阻断本次连接（QA 审查 P1）。
  // 记住开启且本次输入了账号密码时才保存（首次录入）；RustDesk 凭据由官方客户端管理，不入库。
  const shouldSave =
    remember.value && protocol.value !== 'rustdesk' && !!username.value && !!password.value
  const saveProtocol = protocol.value
  const saveUsername = username.value
  const savePassword = password.value
  try {
    const result = await unwrap(
      api.sessionConnect({
        deviceId: device.id,
        ip: device.ip,
        protocol: protocol.value,
        port: connectionPort.value,
        username: username.value || undefined,
        password: password.value || undefined,
        rustdeskId: rustdeskId.value || undefined,
        clipboardSharing: clipboardSharing.value,
        driveRedirection: protocol.value === 'rdp' ? driveRedirection.value : undefined,
        // 带上预检结果，把"端口预检"与"本次连接"串进同一条 traceId 事件链。
        // 必须展开成纯对象：ref 里的值是响应式 Proxy，直接传会被 IPC 结构化克隆拒绝。
        precheck: precheckSnapshot(precheck.value)
      })
    )
    if (!result.ok) {
      // result.message 已由主进程带上失败分类提示，直接展示并展开排查指引。
      lastFailed.value = true
      activeTroubleshoot.value = ['guide']
      ElMessage.error(result.message)
      return
    }
    // 连接已成功后才保存凭据，且独立吞掉失败，不影响本次连接。
    if (shouldSave) {
      try {
        await unwrap(
          api.credentialSet({
            deviceId: device.id,
            protocol: saveProtocol,
            username: saveUsername,
            password: savePassword
          })
        )
      } catch {
        // 凭据保存失败不阻断已成功的连接，下次会退回手输
      }
    }
    lastFailed.value = false
    activeTroubleshoot.value = []
    const capText = result.capabilities?.length ? `\n${result.capabilities.join('；')}` : ''
    ElMessage({ type: 'success', message: result.message + capText, duration: 8000 })
    emit('connected')
    visible.value = false
  } catch (error) {
    lastFailed.value = true
    activeTroubleshoot.value = ['guide']
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
        <p v-if="detectedPortsLabel" class="ld-muted field-hint">
          已发现端口：{{ detectedPortsLabel }}<template v-if="connectionPort"> · 本次自动使用 {{ connectionPort }}</template>
        </p>
        <p v-else class="ld-muted field-hint">未发现已识别服务端口，将使用协议默认端口连接。</p>
      </div>

      <!-- 连接前端口预检：skipped 表示协议不做 TCP 探测（如 RustDesk），不显示"不可达"红点 -->
      <div v-if="precheck && precheck.skipped" class="precheck-bar skipped">
        <span>该协议由客户端自行处理连接，跳过端口预检</span>
      </div>
      <div v-else-if="precheck && precheck.port > 0" class="precheck-bar" :class="precheck.reachable ? 'ok' : 'bad'">
        <span class="precheck-dot" />
        <span v-if="precheck.reachable">
          端口 {{ precheck.port }} 可达 · 往返约 {{ precheck.latencyMs }} ms
        </span>
        <span v-else>
          {{ precheckMessage || `端口 ${precheck.port} 未响应——请确认被控端已开启对应服务或检查防火墙` }}
        </span>
        <el-button link size="small" :loading="prechecking" @click="runPrecheck">重新检测</el-button>
      </div>

      <!-- v1.5 P0-4: 自检结论 + 可执行指引；仅非"可连接"且有结论时展示 -->
      <div
        v-if="precheck && precheck.conclusion && precheck.conclusion !== 'reachable'"
        class="conclusion-box"
        :class="precheck.conclusion"
      >
        <div class="conclusion-title">自检结论：{{ conclusionLabels[precheck.conclusion] }}</div>
        <div v-if="precheck.actions && precheck.actions.length" class="conclusion-actions">
          <div v-for="(action, idx) in precheck.actions" :key="idx" class="conclusion-action">
            → {{ action }}
          </div>
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
            <span class="ld-muted cap-note">{{ sysCaps?.clipboardNote ?? caps.clipboard.note }}</span>
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
            <span class="ld-muted cap-note">{{ sysCaps?.fileTransferNote ?? caps.fileTransfer.note }}</span>
          </div>
          <el-switch
            v-if="protocol === 'rdp'"
            v-model="driveRedirection"
            size="small"
          />
          <span v-else-if="caps.fileTransfer.supported" class="ld-tag">客户端内</span>
          <span v-else class="ld-tag muted">用 SMB 通道</span>
        </div>
        <p v-if="sysCaps" class="cap-prereq">连接前：{{ sysCaps.prerequisite }}</p>
        <p v-if="protocol === 'rdp' && driveRedirection" class="cap-warning">
          注意：磁盘重定向开启后，被控端可访问你本机映射的磁盘。仅对可信设备开启。
        </p>
      </div>

      <div class="notice">
        <p v-if="protocol === 'rdp'">
          RDP 密码经系统 DPAPI 加密后仅在本机有效，<b>不会明文写入 .rdp 文件、不进进程命令行</b>；开启保存后下次可免密直连。
        </p>
        <p v-else-if="protocol === 'vnc'">
          VNC 协议使用明文传输风险较高，请仅在可信局域网使用；密码由 VNC Viewer 弹窗输入，不经命令行传递。
        </p>
        <p v-else>
          RustDesk 的剪贴板同步与文件传输由官方客户端原生提供，连接后在其窗口内使用。
        </p>
        <p v-if="protocol !== 'rustdesk'">
          <el-switch v-model="remember" size="small" />
          <span>自动保存账号密码到本机（DPAPI 加密，不存明文），下次点击直接连接</span>
        </p>
      </div>

      <!-- 连不上时的可折叠排查指引，失败后自动展开 -->
      <div class="troubleshoot-box" :class="{ failed: lastFailed }">
        <el-collapse v-model="activeTroubleshoot">
          <el-collapse-item title="连不上？排查指引" name="guide">
            <div v-for="group in troubleshooting" :key="group.title" class="troubleshoot-group">
              <strong>{{ group.title }}</strong>
              <ul>
                <li v-for="(tip, idx) in group.items" :key="idx">{{ tip }}</li>
              </ul>
            </div>
          </el-collapse-item>
        </el-collapse>
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
.precheck-bar.skipped {
  background: #f1f5f9;
  color: #475569;
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
/* v1.5 P0-4: 自检结论提示框，与 cap-prereq / troubleshoot-box 风格自洽 */
.conclusion-box {
  border: 1px solid #bfdbfe;
  border-radius: 8px;
  background: #eff6ff;
  color: #1d4ed8;
  padding: 9px 12px;
  font-size: 12px;
  line-height: 1.7;
}
.conclusion-box.offline,
.conclusion-box.port_closed {
  border-color: #fed7aa;
  background: #fff7ed;
  color: #9a3412;
}
.conclusion-box.firewall_or_auth,
.conclusion-box.unknown {
  border-color: #fde68a;
  background: #fffbeb;
  color: #b45309;
}
.conclusion-title {
  font-weight: 700;
}
.conclusion-actions {
  margin-top: 4px;
}
.conclusion-action {
  word-break: break-word;
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
.cap-prereq {
  font-size: 11px;
  color: #1d4ed8;
  background: #eff6ff;
  border-radius: 6px;
  padding: 6px 8px;
  margin: 8px 0 0;
  line-height: 1.5;
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
.troubleshoot-box {
  border: 1px solid var(--ld-border);
  border-radius: 8px;
  background: #f8fafc;
  padding: 2px 12px;
}
.troubleshoot-box.failed {
  border-color: #fca5a5;
  background: #fff7f7;
}
.troubleshoot-group + .troubleshoot-group {
  margin-top: 10px;
}
.troubleshoot-group strong {
  font-size: 12px;
  color: #334155;
}
.troubleshoot-group ul {
  margin: 6px 0 2px;
  padding-left: 18px;
}
.troubleshoot-group li {
  font-size: 12px;
  line-height: 1.7;
  color: #526074;
}
</style>
