<template>
  <section class="page" data-module="spare">
    <header class="page-head">
      <div>
        <h2>备品备件管理</h2>
        <p class="page-desc">缺陷闭环结论回写待领用台账；“在办缺陷数”与缺陷消缺页同一口径，两处必须对得上。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记备品备件</button>
        <button class="btn" type="button" @click="exportRows">导出备品备件清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">备件品类</span>
        <strong class="stat-value">{{ rows.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待补充品类</span>
        <strong class="stat-value">{{ rows.filter((row) => row.status === '待补充').length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">低于安全存量</span>
        <strong class="stat-value">{{ belowSafetyCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">在办缺陷数（与缺陷页一致）</span>
        <strong class="stat-value">{{ activeCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待领用台账</span>
        <strong class="stat-value" :class="{ danger: ledgerRows.length > 0 }">{{ ledgerRows.length }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <h3 class="subsection-title">待领用台账（缺陷闭环回写）</h3>
    <table class="data-table ledger-table">
      <thead>
        <tr>
          <th>台账编号</th>
          <th>备件编号</th>
          <th>备件名称</th>
          <th>规格型号</th>
          <th>数量</th>
          <th>来源缺陷</th>
          <th>责任班组</th>
          <th>登记时间</th>
          <th>闭环结论</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in ledgerRows" :key="String(item.id)">
          <td>{{ item.id }}</td>
          <td>{{ item['备件编号'] }}</td>
          <td>{{ item['备件名称'] }}</td>
          <td>{{ item['规格型号'] }}</td>
          <td>{{ item.数量 }}</td>
          <td>{{ item.缺陷编号 }}</td>
          <td>{{ item.责任班组 }}</td>
          <td>{{ item.登记时间 }}</td>
          <td class="conclusion-cell">{{ item.闭环结论 }}</td>
          <td>{{ item.状态 }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="receive(item.id)">办理领用</button>
          </td>
        </tr>
        <tr v-if="!ledgerRows.length">
          <td :colspan="11" class="empty-state">暂无待领用备件，缺陷闭环且登记了需用备件时会自动回写</td>
        </tr>
      </tbody>
    </table>

    <h3 class="subsection-title">备件库存</h3>
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

    <footer class="page-foot">
      <span>共 {{ total }} 条备品备件记录</span>
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
import {
  activeDefectCount,
  listPendingLedger,
  receiveLedger,
} from '@/api/defect-service'
import type { EntryRow, LedgerRow } from '@/data/types'

const meta = moduleMeta('spare')
const columns = ['备件编号', '备件名称', '适用设备', '规格型号', '现有数量', '安全存量', '存放库位', '备件状态']
const actions = ['申请补充', '提交检验', '办理领用']
const statuses = ['数量充足', '待补充', '待检验', '已停用']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const ledgerRows = ref<LedgerRow[]>([])
const activeCount = ref(0)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const belowSafetyCount = computed(() =>
  rows.value.filter((row) => Number(row['现有数量']) < Number(row['安全存量'])).length,
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

function receive(id: number) {
  errorMessage.value = ''
  const result = receiveLedger(id)
  if (!result.ok) {
    errorMessage.value = result.message
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 在办缺陷数直接用缺陷领域服务的口径，不在这里另算。
    activeCount.value = activeDefectCount()
    ledgerRows.value = listPendingLedger()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '备品备件列表读取失败'
  }
}

onMounted(reload)
</script>
