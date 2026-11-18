<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api, unwrap } from '../api'
import type { ProtocolId, SessionRecord, SessionStatus } from '../../../shared/types'

const records = ref<SessionRecord[]>([])
const protocolLabels: Record<ProtocolId, string> = {
  rdp: 'RDP',
  vnc: 'VNC',
  rustdesk: 'RustDesk'
}
const statusLabels: Record<SessionStatus, string> = {
  idle: '空闲',
  connecting: '连接中',
  connected: '已调起',
  failed: '失败'
}
const statusClass: Record<SessionStatus, string> = {
  idle: 'muted',
  connecting: '',
  connected: 'success',
  failed: 'danger'
}

function formatTime(value: string): string {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

onMounted(() => {
  void unwrap(api.sessionList())
    .then((list) => {
      records.value = list
    })
    .catch((error: unknown) => {
      ElMessage.error(error instanceof Error ? error.message : String(error))
    })
})
</script>

<template>
  <section class="ld-panel">
    <div class="history-head">
      <div>
        <h2>连接历史</h2>
        <p class="ld-muted">记录最近 200 次连接尝试。外部客户端一旦调起即记为“已调起”，本应用不接管远端会话的结束时刻。</p>
      </div>
      <span class="ld-tag muted">共 {{ records.length }} 条</span>
    </div>
    <el-table :data="records" stripe style="width: 100%" max-height="520">
      <el-table-column label="设备" min-width="150">
        <template #default="scope">{{ (scope.row as SessionRecord).deviceName }}</template>
      </el-table-column>
      <el-table-column label="协议" width="100">
        <template #default="scope">{{ protocolLabels[(scope.row as SessionRecord).protocol] }}</template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="scope">
          <span class="ld-tag" :class="statusClass[(scope.row as SessionRecord).status]">
            {{ statusLabels[(scope.row as SessionRecord).status] }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="发起时间" min-width="180">
        <template #default="scope">{{ formatTime((scope.row as SessionRecord).startedAt) }}</template>
      </el-table-column>
      <el-table-column label="结束时间" min-width="180">
        <template #default="scope">{{ formatTime((scope.row as SessionRecord).endedAt) }}</template>
      </el-table-column>
      <el-table-column label="备注" min-width="220">
        <template #default="scope">
          <span class="ld-muted error-text">{{ (scope.row as SessionRecord).errorMessage || '-' }}</span>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="records.length === 0" description="还没有连接记录" />
  </section>
</template>

<style scoped>
.history-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
}
h2 {
  margin: 0 0 4px;
  font-size: 18px;
}
.history-head p {
  margin: 0;
  font-size: 12px;
}
.error-text {
  font-size: 12px;
}
</style>
