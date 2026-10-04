<template>
  <section class="page" data-module="spare">
    <header class="page-head">
      <div>
        <h2>备品备件管理</h2>
        <p class="page-desc">维护备品备件台账；消缺确认闭环后，领用结论自动回写下方「待领用台账」。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记备品备件</button>
        <button class="btn" type="button" @click="exportRows">导出备品备件清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ warn: item.warn }">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">在办缺陷数（与缺陷消缺页同口径）：{{ activeDefects }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无备品备件数据，可先登记备品备件</td>
        </tr>
      </tbody>
    </table>

    <h3 class="ledger-title">待领用台账（消缺闭环回写）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in ledgerColumns" :key="column">{{ column }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in ledger" :key="String(row.id)">
          <td v-for="column in ledgerColumns" :key="column">{{ row[column] ?? '—' }}</td>
        </tr>
        <tr v-if="!ledger.length">
          <td :colspan="ledgerColumns.length" class="empty-state">暂无待领用记录，消缺确认闭环时登记的备件会出现在这里</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条备品备件记录，待领用 {{ pendingLedger }} 件</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { activeDefectCount, ledgerPendingCount, listLedger } from '@/api/defect'
import type { EntryRow, SpareLedgerRow } from '@/data/types'

const meta = moduleMeta('spare')
const columns = ['备件编号', '备件名称', '适用设备', '规格型号', '现有数量', '安全存量', '存放库位', '备件状态']
const actions = ['申请补充', '提交检验', '办理领用']
const statuses = ['数量充足', '待补充', '待检验', '已停用']
const ledgerColumns = ['缺陷编号', '备件编号', '备件名称', '数量', '责任班组', '登记时间', '状态']

const rows = ref<EntryRow[]>([])
const ledger = ref<SpareLedgerRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const activeDefects = ref(0)
const pendingLedger = ref(0)

const stats = computed(() => [
  { label: '备件品类', value: rows.value.length, warn: false },
  { label: '待补充品类', value: rows.value.filter((row) => String(row.status) === '待补充').length, warn: false },
  { label: '在办缺陷数', value: activeDefects.value, warn: false },
  { label: '待领用件数', value: pendingLedger.value, warn: pendingLedger.value > 0 },
])
const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '备品备件登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    ledger.value = listLedger()
    // 与缺陷页共用 activeDefectCount / ledgerPendingCount，两处在办缺陷数、待领用件数不会对不上。
    activeDefects.value = activeDefectCount()
    pendingLedger.value = ledgerPendingCount()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '备品备件列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.ledger-title {
  margin: 18px 0 8px;
  font-size: 15px;
}
.warn {
  color: #b42318;
}
</style>
