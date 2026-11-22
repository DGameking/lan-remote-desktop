<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ScanProgress, SubnetView } from '../../../shared/types'

const props = defineProps<{
  scanning: boolean
  progress: ScanProgress
  subnet: string
  deviceCount: number
  /** v1.4-A: 网段候选列表与当前选中目标 */
  subnets?: SubnetView[]
  targetCidr?: string
}>()

const emit = defineEmits<{
  (e: 'start'): void
  (e: 'stop'): void
  (e: 'update:targetCidr', value: string): void
}>()

// 手动网段输入：下拉选择 + 手动输入两种入口，最终都归一化到 targetCidr。
const manualInput = ref('')
const manualMode = ref(false)
const selectedCidr = computed(() => props.targetCidr ?? '')

watch(
  () => props.targetCidr,
  (value) => {
    if (value) manualInput.value = value
  },
  { immediate: true }
)

function onSelect(value: string): void {
  emit('update:targetCidr', value)
}

function applyManual(): void {
  const value = manualInput.value.trim()
  if (!value) return
  emit('update:targetCidr', value)
}

function subnetLabel(item: SubnetView): string {
  const tags: string[] = []
  if (item.isPrimary) tags.push('主网段')
  if (item.kind === 'virtual') tags.push('虚拟网卡')
  const suffix = tags.length ? `（${tags.join(' · ')}）` : ''
  return `${item.cidr}${suffix}`
}
</script>

<template>
  <section class="ld-panel scan-panel">
    <div class="scan-left">
      <div class="scan-title">
        <span class="scan-icon">◎</span>
        <div>
          <h2>局域网设备发现</h2>
          <p class="ld-muted">扫描本机所在网段的 22 / 445 / 3389 / 5900-5910 / 5666 / 5985 等端口，识别原生远程桌面能力，并结合 mDNS 与 ARP 表补充设备信息。</p>
        </div>
      </div>
      <div class="scan-meta">
        <span class="ld-tag">当前网段 {{ props.subnet || '检测中…' }}</span>
        <span class="ld-tag muted">已发现 {{ props.deviceCount }} 台</span>
        <span class="ld-tag muted">分层扫描 · 存活快扫 + 服务指纹识别</span>
      </div>
      <div class="subnet-picker" v-if="props.subnets && props.subnets.length">
        <span class="picker-label">扫描目标</span>
        <el-select
          v-if="!manualMode"
          :model-value="selectedCidr"
          size="small"
          placeholder="选择网段"
          @update:model-value="onSelect"
        >
          <el-option
            v-for="item in props.subnets"
            :key="item.cidr"
            :label="subnetLabel(item)"
            :value="item.cidr"
          />
        </el-select>
        <el-input
          v-else
          v-model="manualInput"
          size="small"
          placeholder="192.168.10.0/24 或 192.168.10.68"
          style="width: 230px"
          @keyup.enter="applyManual"
        />
        <el-button size="small" text type="primary" @click="applyManual">应用</el-button>
        <el-button size="small" text @click="manualMode = !manualMode">
          {{ manualMode ? '选择已知网段' : '手动输入网段' }}
        </el-button>
        <span class="picker-hint ld-muted">默认识别路由器所在的“主网段”，虚拟网卡已降权</span>
      </div>
    </div>
    <div class="scan-right">
      <div v-if="props.scanning" class="progress-block">
        <el-progress :percentage="props.progress.percent" :stroke-width="10" striped striped-flow />
        <p class="ld-muted progress-text">{{ props.progress.message }}</p>
        <el-button size="small" @click="emit('stop')">停止扫描</el-button>
      </div>
      <template v-else>
        <el-button type="primary" size="large" @click="emit('start')">开始扫描</el-button>
        <p class="ld-muted hint">仅在本机执行，不向公网发送任何数据</p>
      </template>
    </div>
  </section>
</template>

<style scoped>
.scan-panel {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 24px;
  background: linear-gradient(120deg, #ffffff 0%, #f7faff 100%);
}
.scan-title {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.scan-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: var(--ld-primary-soft);
  color: var(--ld-primary);
  font-size: 22px;
  flex-shrink: 0;
}
.scan-title h2 {
  margin: 0 0 4px;
  font-size: 17px;
}
.scan-title p {
  margin: 0;
  font-size: 12px;
}
.scan-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 14px;
  padding-left: 50px;
}
.subnet-picker {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  padding-left: 50px;
}
.picker-label {
  font-size: 12px;
  font-weight: 500;
}
.picker-hint {
  font-size: 11px;
}
.scan-right {
  flex-shrink: 0;
  min-width: 210px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}
.progress-block {
  width: 260px;
}
.progress-text {
  font-size: 12px;
  margin: 8px 0;
  min-height: 18px;
}
.hint {
  font-size: 11px;
  margin: 0;
}
</style>
