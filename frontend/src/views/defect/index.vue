<template>
  <section class="page" data-module="defect">
    <header class="page-head">
      <div>
        <h2>缺陷消缺管理</h2>
        <p class="page-desc">待派发 → 消缺中 → 待验收 → 已闭环，只许顺流；超期口径、闭环结论、备品台账同一笔事务提交。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" :disabled="backfillRemainingCount === 0" @click="runBackfill">
          补齐要求完成日（剩 {{ backfillRemainingCount }} 条）
        </button>
        <button class="btn" type="button" @click="exportRows">导出闭环册子</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ danger: item.danger && item.value > 0 }">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">当前身份：{{ store.role }} · {{ store.crew }}（{{ store.operator }}）</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <label class="filter-item">
        <span>消缺状态</span>
        <select v-model="statusFilter">
          <option value="">全部</option>
          <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table defect-table">
      <thead>
        <tr>
          <th>缺陷编号</th>
          <th>缺陷类别</th>
          <th>发现方式</th>
          <th>严重等级</th>
          <th>责任班组</th>
          <th>发现日期</th>
          <th>要求完成日</th>
          <th>实际完成时间</th>
          <th>消缺措施</th>
          <th>需用备件</th>
          <th>超期标记</th>
          <th>当前状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="view in visibleRows" :key="String(view.row.id)">
          <td>{{ view.row['缺陷编号'] ?? '—' }}</td>
          <td>{{ view.row['缺陷类别'] ?? '—' }}</td>
          <td>{{ view.row['发现方式'] ?? '—' }}</td>
          <td>{{ view.row['严重等级'] ?? '—' }}</td>
          <td>{{ view.row['责任班组'] ?? '—' }}</td>
          <td>{{ view.row['发现日期'] || '—' }}</td>
          <td>
            <template v-if="canEditDeadline(store.operatorInfo, view.row)">
              <input
                v-model="deadlineDrafts[view.row.id]"
                class="cell-input"
                type="date"
                :aria-label="`${view.row['缺陷编号']} 要求完成日`"
              />
              <button
                class="link"
                type="button"
                :disabled="busyId === view.row.id"
                @click="saveDeadline(view.row)"
              >保存</button>
            </template>
            <template v-else>
              <span :class="{ muted: view.deadlineMissing }">{{ view.row['要求完成日'] || '待补齐' }}</span>
              <span v-if="!view.closed && store.role !== '班长'" class="lock-hint" title="只有本责任班组班长可改">🔒</span>
            </template>
          </td>
          <td>{{ view.row['实际完成时间'] || '—' }}</td>
          <td>
            <textarea
              v-model="measureDrafts[view.row.id]"
              class="cell-area"
              rows="2"
              :disabled="view.closed"
              :title="view.closed ? '已闭环，消缺措施冻结' : ''"
            ></textarea>
            <button
              v-if="!view.closed"
              class="link"
              type="button"
              :disabled="busyId === view.row.id"
              @click="saveMeasure(view.row)"
            >保存措施</button>
            <span v-else class="lock-hint" title="已闭环，措施不可再动">已冻结</span>
          </td>
          <td>
            <input
              v-model="spareDrafts[view.row.id]"
              class="cell-input"
              :disabled="view.closed"
              placeholder="如 SPAR-0001 ×3"
            />
            <button
              v-if="!view.closed"
              class="link"
              type="button"
              :disabled="busyId === view.row.id"
              @click="saveSpare(view.row)"
            >保存</button>
          </td>
          <td>
            <span class="overdue-tag" :class="overdueClass(view)">
              {{ view.overdue ? (view.closed ? '超期闭环' : '超期') : (view.deadlineMissing && !view.closed ? '待补齐' : '正常') }}
              <template v-if="view.overdue"> {{ view.overdueDays }}天</template>
            </span>
          </td>
          <td>{{ view.row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(view.row)">详情</button>
            <button
              v-if="view.row.status === '待派发'"
              class="link"
              type="button"
              :disabled="busyId === view.row.id"
              @click="run('dispatchDefect', view.row)"
            >派发消缺</button>
            <button
              v-if="view.row.status === '消缺中'"
              class="link"
              type="button"
              :disabled="busyId === view.row.id"
              @click="run('submitDefect', view.row)"
            >提交验收</button>
            <button
              v-if="view.row.status === '待验收'"
              class="link primary-link"
              type="button"
              :disabled="busyId === view.row.id"
              @click="openClose(view.row)"
            >确认闭环</button>
            <span v-if="view.closed" class="lock-hint">已闭环</span>
          </td>
        </tr>
        <tr v-if="!visibleRows.length">
          <td :colspan="13" class="empty-state">暂无符合条件的缺陷消缺记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ visibleRows.length }} 条显示，在办缺陷 {{ statsInfo.active }} 条（备品页台账同口径）</span>
      <span v-if="message" :class="messageTone === 'error' ? 'error-text' : 'ok-text'">{{ message }}</span>
    </footer>

    <!-- 确认闭环弹窗：实际完成时间可补录，默认今天；提示与要求完成日是否对得上 -->
    <div v-if="closeTarget" class="modal-mask" @click.self="cancelClose">
      <div class="modal-card">
        <h3>确认闭环 · {{ closeTarget['缺陷编号'] }}</h3>
        <dl class="detail-list">
          <div><dt>当前状态</dt><dd>{{ closeTarget.status }} → 已闭环</dd></div>
          <div><dt>要求完成日</dt><dd>{{ closeTarget['要求完成日'] || '待补齐' }}</dd></div>
          <div><dt>消缺措施</dt><dd>{{ closeTarget['消缺措施'] || '（未填写）' }}</dd></div>
          <div><dt>需用备件</dt><dd>{{ closeTarget['需用备件'] || '无' }}</dd></div>
        </dl>
        <label class="filter-item">
          <span>实际完成时间（补录）</span>
          <input v-model="closeDate" type="date" />
        </label>
        <p class="modal-hint" :class="closePreview.overdue ? 'error-text' : 'ok-text'">
          按此完成时间：{{ closePreview.text }}
        </p>
        <p class="modal-hint muted">连续点击“确认闭环”只记一次；超期标记、台账回写与状态同一笔事务，失败整笔回滚。</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="cancelClose">取消</button>
          <button class="btn primary" type="button" :disabled="busyId === closeTarget.id" @click="confirmClose">
            {{ busyId === closeTarget.id ? '提交中…' : '确认闭环' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 详情面板：与列表、导出册子同一套算法 -->
    <div v-if="detailView" class="drawer-mask" @click.self="detailView = undefined">
      <aside class="drawer-card">
        <header class="drawer-head">
          <h3>{{ detailView.row['缺陷编号'] }} · 消缺详情</h3>
          <button class="link" type="button" @click="detailView = undefined">关闭</button>
        </header>
        <dl class="detail-list">
          <div><dt>缺陷类别</dt><dd>{{ detailView.row['缺陷类别'] }}</dd></div>
          <div><dt>发现方式</dt><dd>{{ detailView.row['发现方式'] }}（时限 {{ slaText(detailView.row['发现方式']) }}）</dd></div>
          <div><dt>严重等级</dt><dd>{{ detailView.row['严重等级'] }}</dd></div>
          <div><dt>责任班组</dt><dd>{{ detailView.row['责任班组'] }}</dd></div>
          <div><dt>发现日期</dt><dd>{{ detailView.row['发现日期'] || '—' }}</dd></div>
          <div><dt>要求完成日</dt><dd>{{ detailView.row['要求完成日'] || '待补齐' }}</dd></div>
          <div><dt>实际完成时间</dt><dd>{{ detailView.row['实际完成时间'] || '—' }}</dd></div>
          <div><dt>当前状态</dt><dd>{{ detailView.row.status }}</dd></div>
          <div><dt>超期结论</dt><dd>{{ detailView.overdueText }}</dd></div>
          <div><dt>消缺措施</dt><dd>{{ detailView.row['消缺措施'] || '—' }}</dd></div>
          <div><dt>需用备件</dt><dd>{{ detailView.row['需用备件'] || '无' }}</dd></div>
          <div><dt>闭环结论</dt><dd>{{ detailView.row['闭环结论'] || (detailView.closed ? '—' : '（闭环后回写）') }}</dd></div>
          <div>
            <dt>待领用台账</dt>
            <dd v-if="detailLedger">
              {{ detailLedger['备件编号'] }} ×{{ detailLedger.数量 }}，{{ detailLedger.状态 }}
              <span v-if="detailLedger.状态 === '待领用'">（待班组领用）</span>
            </dd>
            <dd v-else-if="detailView.closed">无备件领用记录</dd>
            <dd v-else>闭环后按需用备件回写</dd>
          </div>
        </dl>
        <p class="modal-hint muted">清缓存重开或导出册子，均按本面板同一口径重算；历史已闭环结论保持原样。</p>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  backfillDeadlineStep,
  backfillRemaining,
  canEditDeadline,
  closeDefect,
  DEFECT_CONST,
  defectDetail,
  defectStats,
  deriveDefect,
  dispatchDefect,
  exportDefectsCsv,
  ledgerForDefect,
  listDefects,
  submitDefect,
  today,
  updateDeadline,
  updateMeasure,
  updateRequiredSpare,
  type DefectView,
} from '@/api/defect-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow, LedgerRow } from '@/data/types'

const store = useSessionStore()
const statuses = [...DEFECT_CONST.STATUSES]
const filterFields = ['缺陷编号', '缺陷类别', '发现方式', '责任班组']

const rows = ref<EntryRow[]>([])
const filters = reactive<Record<string, string>>({})
const statusFilter = ref('')
const message = ref('')
const messageTone = ref<'ok' | 'error'>('ok')
const busyId = ref<number | null>(null)

const deadlineDrafts = reactive<Record<number, string>>({})
const measureDrafts = reactive<Record<number, string>>({})
const spareDrafts = reactive<Record<number, string>>({})

const closeTarget = ref<EntryRow | null | undefined>(undefined)
const closeDate = ref(today())
const detailView = ref<DefectView | null | undefined>(undefined)
const detailLedger = ref<LedgerRow | undefined>(undefined)

const views = computed(() => rows.value.map((row) => deriveDefect(row)))
const visibleRows = computed(() =>
  statusFilter.value ? views.value.filter((view) => view.row.status === statusFilter.value) : views.value,
)

const statsInfo = computed(() => defectStats({}))
const backfillRemainingCount = computed(() => backfillRemaining())
const statCards = computed(() => [
  { label: '待派发', value: statsInfo.value.pendingDispatch, danger: false },
  { label: '消缺中', value: statsInfo.value.fixing, danger: false },
  { label: '待验收', value: statsInfo.value.pendingAcceptance, danger: false },
  { label: '超期未闭环', value: statsInfo.value.overdueOpen, danger: true },
])
const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: views.value.filter((view) => view.row.status === status).length })),
)

const closePreview = computed(() => {
  if (!closeTarget.value) {
    return { overdue: false, text: '' }
  }
  const deadline = String(closeTarget.value['要求完成日'] ?? '')
  const merged: EntryRow = {
    ...closeTarget.value,
    status: '已闭环',
    pending: false,
    abnormal: /^\d{4}-\d{2}-\d{2}$/.test(deadline) && closeDate.value > deadline,
    实际完成时间: closeDate.value,
  }
  const view = deriveDefect(merged, closeDate.value)
  return { overdue: view.overdue, text: view.overdueText }
})

function flash(text: string, tone: 'ok' | 'error' = 'ok') {
  message.value = text
  messageTone.value = tone
}

function seedDrafts(list: EntryRow[]) {
  for (const row of list) {
    if (deadlineDrafts[row.id] === undefined) {
      deadlineDrafts[row.id] = String(row['要求完成日'] ?? '')
    }
    if (measureDrafts[row.id] === undefined) {
      measureDrafts[row.id] = String(row['消缺措施'] ?? '')
    }
    if (spareDrafts[row.id] === undefined) {
      spareDrafts[row.id] = String(row['需用备件'] ?? '')
    }
  }
}

function reload() {
  message.value = ''
  try {
    rows.value = listDefects(filters)
    seedDrafts(rows.value)
  } catch (error) {
    flash(error instanceof Error ? error.message : '缺陷消缺列表读取失败', 'error')
  }
}

function resetFilters() {
  for (const key of Object.keys(filters)) {
    filters[key] = ''
  }
  statusFilter.value = ''
  reload()
}

async function run(kind: 'dispatchDefect' | 'submitDefect', row: EntryRow) {
  if (busyId.value !== null) {
    return
  }
  busyId.value = Number(row.id)
  // 让按钮先进入“提交中”，再执行动作；两次连点的第二次直接被 busy 挡掉。
  await new Promise((resolve) => window.setTimeout(resolve, 0))
  const result = kind === 'dispatchDefect'
    ? dispatchDefect(Number(row.id))
    : submitDefect(Number(row.id))
  busyId.value = null
  flash(result.message, result.ok ? 'ok' : 'error')
  reload()
}

function openClose(row: EntryRow) {
  if (busyId.value !== null) {
    return
  }
  closeTarget.value = row
  closeDate.value = today()
}

function cancelClose() {
  if (busyId.value !== null) {
    return
  }
  closeTarget.value = null
}

async function confirmClose() {
  if (!closeTarget.value || busyId.value !== null) {
    return
  }
  const id = Number(closeTarget.value.id)
  busyId.value = id
  await new Promise((resolve) => window.setTimeout(resolve, 0))
  const result = closeDefect(id, store.operatorInfo, closeDate.value)
  busyId.value = null
  closeTarget.value = null
  flash(result.message, result.ok ? 'ok' : 'error')
  reload()
}

function saveDeadline(row: EntryRow) {
  const result = updateDeadline(Number(row.id), deadlineDrafts[row.id] ?? '', store.operatorInfo)
  flash(result.message, result.ok ? 'ok' : 'error')
  reload()
}

function saveMeasure(row: EntryRow) {
  const result = updateMeasure(Number(row.id), measureDrafts[row.id] ?? '', store.operatorInfo)
  flash(result.message, result.ok ? 'ok' : 'error')
  reload()
}

function saveSpare(row: EntryRow) {
  const result = updateRequiredSpare(Number(row.id), spareDrafts[row.id] ?? '', store.operatorInfo)
  flash(result.message, result.ok ? 'ok' : 'error')
  reload()
}

function runBackfill() {
  const result = backfillDeadlineStep()
  flash(result.message, result.ok ? 'ok' : 'error')
  reload()
}

function openDetail(row: EntryRow) {
  detailView.value = defectDetail(Number(row.id)) ?? null
  // 台账回写情况直接读备品待领用台账，两处一致才展示“已回写”。
  detailLedger.value = ledgerForDefect(String(row['缺陷编号']))
}

function overdueClass(view: DefectView): string {
  if (view.overdue) {
    return 'tag-danger'
  }
  if (view.deadlineMissing && !view.closed) {
    return 'tag-warn'
  }
  return 'tag-ok'
}

function slaText(discovery: unknown): string {
  const days = DEFECT_CONST.SLA_DAYS_BY_DISCOVERY[String(discovery ?? '')] ?? 10
  return `${days} 天`
}

function exportRows() {
  const { filename, content } = exportDefectsCsv(filters)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

onMounted(reload)
</script>
