<script setup lang="ts">
import type { ScanProgress } from '../../../shared/types'

const props = defineProps<{
  scanning: boolean
  progress: ScanProgress
  subnet: string
  deviceCount: number
}>()

const emit = defineEmits<{
  (e: 'start'): void
  (e: 'stop'): void
}>()
</script>

<template>
  <section class="ld-panel scan-panel">
    <div class="scan-left">
      <div class="scan-title">
        <span class="scan-icon">◎</span>
        <div>
          <h2>局域网设备发现</h2>
          <p class="ld-muted">扫描本机所在网段的 3389 / 5900 / 21116 端口，并结合 mDNS 与 ARP 表补充设备信息。</p>
        </div>
      </div>
      <div class="scan-meta">
        <span class="ld-tag">当前网段 {{ props.subnet || '检测中…' }}</span>
        <span class="ld-tag muted">已发现 {{ props.deviceCount }} 台</span>
        <span class="ld-tag muted">并发 50 · 超时 400ms</span>
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
