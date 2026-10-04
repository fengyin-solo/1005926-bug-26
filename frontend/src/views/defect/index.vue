<template>
  <section class="page" data-module="defect">
    <header class="page-head">
      <div>
        <h2>缺陷消缺管理</h2>
        <p class="page-desc">消缺状态只能顺着流转：待派发 → 消缺中 → 待验收 → 已闭环；闭环结论回写备品备件待领用台账。</p>
      </div>
      <div class="page-actions">
        <label class="identity-pick">
          当前身份
          <select :value="store.operator.name" @change="switchIdentity">
            <option v-for="op in presetOperators" :key="op.name" :value="op.name">
              {{ op.name }}（{{ op.role }}<template v-if="op.crew"> · {{ op.crew }}</template>）
            </option>
          </select>
        </label>
        <button class="btn" type="button" @click="runBackfill">按发现方式补齐要求完成日</button>
        <button class="btn" type="button" @click="exportBooklet">另存闭环册子</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ warn: item.warn }">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">在办缺陷数（与备品备件页同口径）：{{ stats.active }}</span>
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
          <th>超期标记</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>
            <button class="link" type="button" @click="openDetail(row)">{{ row['缺陷编号'] }}</button>
          </td>
          <td v-for="column in columns.slice(1)" :key="column">{{ row[column] || '—' }}</td>
          <td>
            <span v-if="row.超期标记" class="tag" :class="row.status === '已闭环' ? 'tag-muted' : 'tag-warn'">
              {{ row.超期标记 }}
            </span>
            <span v-else>—</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-if="row.status !== '已闭环'"
              class="link"
              type="button"
              :disabled="closingId === row.id"
              @click="runAction(actionFor(row.status), row)"
            >
              {{ actionFor(row.status) }}
            </button>
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <span v-if="row.status === '已闭环'" class="locked-hint">已锁定</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无缺陷消缺数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条缺陷消缺记录</span>
      <span v-if="message" class="error-text">{{ message }}</span>
    </footer>

    <!-- 详情面板：与列表、册子同一个 viewDefect 口径，清缓存重开也不会变算法 -->
    <div v-if="detail" class="drawer-mask" @click.self="closeDetail">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>缺陷详情 · {{ detail['缺陷编号'] }}</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>

        <dl class="detail-grid">
          <template v-for="field in detailFields" :key="field">
            <dt>{{ field }}</dt>
            <dd>{{ detail[field] || '—' }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd>{{ detail.status }}</dd>
          <dt>超期判定</dt>
          <dd>
            <span v-if="detail.status === '已闭环'">{{ detail.闭环结论 }}</span>
            <span v-else>{{ detail.超期 ? '已超期（要求完成日早于今天）' : '未超期' }}</span>
          </dd>
        </dl>

        <section class="detail-edit">
          <h4>要求完成日</h4>
          <div class="inline-form">
            <input v-model="dueDraft" type="date" :disabled="detail.status === '已闭环'" />
            <button
              class="btn primary"
              type="button"
              :disabled="detail.status === '已闭环'"
              @click="saveDueDate"
            >
              保存要求完成日
            </button>
          </div>
          <p class="hint">
            <template v-if="detail.status === '已闭环'">已闭环记录锁定，不能再改要求完成日。</template>
            <template v-else-if="canEditDue">你是「{{ detail['责任班组'] }}」班长，可以修改。</template>
            <template v-else>仅「{{ detail['责任班组'] }}」的班长可修改（当前：{{ store.operator.name }}）。</template>
          </p>
        </section>

        <section class="detail-edit">
          <h4>消缺措施</h4>
          <textarea v-model="measureDraft" rows="3" :disabled="detail.status === '已闭环'"></textarea>
          <div class="inline-form">
            <button
              class="btn primary"
              type="button"
              :disabled="detail.status === '已闭环'"
              @click="saveMeasure"
            >
              保存消缺措施
            </button>
            <span v-if="detail.status === '已闭环'" class="hint">已闭环，消缺措施不允许再动。</span>
          </div>
        </section>
      </aside>
    </div>

    <!-- 确认闭环：可同时登记领用备件，与状态同一事务回写台账 -->
    <div v-if="closing" class="drawer-mask" @click.self="cancelClose">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>确认闭环 · {{ closing['缺陷编号'] }}</h3>
          <button class="btn ghost" type="button" @click="cancelClose">取消</button>
        </header>
        <p class="hint">
          闭环后状态进入终态「已闭环」，实际完成时间记为今天，超期结论固化；连续重复提交只生效一次。
        </p>
        <div class="close-usages">
          <h4>领用备件（不涉及可不填）</h4>
          <div v-for="(item, idx) in usages" :key="idx" class="usage-row">
            <select v-model="item.备件编号">
              <option value="">选择备件</option>
              <option v-for="spare in spareOptions" :key="String(spare.id)" :value="String(spare['备件编号'])">
                {{ spare['备件编号'] }} · {{ spare['备件名称'] }}
              </option>
            </select>
            <input v-model.number="item.数量" type="number" min="1" step="1" placeholder="数量" />
            <button class="btn ghost" type="button" @click="removeUsage(idx)">删除</button>
          </div>
          <button class="btn" type="button" @click="addUsage">增加备件</button>
        </div>
        <div class="drawer-foot">
          <button class="btn primary" type="button" :disabled="closingId !== null" @click="confirmClose">
            {{ closingId !== null ? '闭环提交中…' : '确认闭环' }}
          </button>
        </div>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  advanceDefect,
  backfillDueDates,
  defectStats,
  downloadTextFile,
  exportDefectBooklet,
  getDefectView,
  listDefectViews,
  updateDueDate,
  updateMeasure,
  type DefectView,
} from '@/api/defect'
import { listRows } from '@/data/local-store'
import type { EntryRow, Operator, SpareUsage } from '@/data/types'
import { PRESET_OPERATORS, useSessionStore } from '@/stores/session'

const store = useSessionStore()
const presetOperators = PRESET_OPERATORS

const columns = ['缺陷编号', '缺陷类别', '发现方式', '严重等级', '责任班组', '发现日期', '要求完成日', '消缺措施']
const detailFields = [...columns, '实际完成时间']
const statuses = ['待派发', '消缺中', '待验收', '已闭环']
const NEXT_ACTION: Record<string, string> = {
  待派发: '派发消缺',
  消缺中: '提交验收',
  待验收: '确认闭环',
}

const rows = ref<DefectView[]>([])
const total = ref(0)
const message = ref('')
const filters = reactive<Record<string, string>>({})
const filterFields = ['缺陷编号', '缺陷类别', '发现方式']

const stats = ref(defectStats())
const statCards = computed(() => [
  { label: '待派发缺陷', value: stats.value.pendingDispatch, warn: false },
  { label: '消缺中缺陷', value: stats.value.inProgress, warn: false },
  { label: '在办缺陷数', value: stats.value.active, warn: false },
  { label: '超期未闭环', value: stats.value.overdueOpen, warn: stats.value.overdueOpen > 0 },
])
const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => row.status === status).length,
  })),
)

function switchIdentity(event: Event) {
  const name = (event.target as HTMLSelectElement).value
  const next = presetOperators.find((item) => item.name === name)
  if (next) {
    store.setOperator(next as Operator)
    if (detail.value) {
      openDetailById(Number(detail.value.id))
    }
  }
}

function resetFilters() {
  for (const key of Object.keys(filters)) {
    delete filters[key]
  }
  reload()
}

function actionFor(status: string): string {
  return NEXT_ACTION[status] ?? ''
}

function flash(text: string) {
  message.value = text
  window.setTimeout(() => {
    if (message.value === text) {
      message.value = ''
    }
  }, 4000)
}

function reload() {
  const payload = listDefectViews(filters)
  rows.value = payload.items
  total.value = payload.total
  stats.value = defectStats()
}

function runAction(action: string, row: DefectView) {
  if (action === '确认闭环') {
    beginClose(row)
    return
  }
  const result = advanceDefect(Number(row.id), action)
  flash(result.message)
  if (result.ok) {
    reload()
  }
}

function runBackfill() {
  const result = backfillDueDates()
  flash(result.message)
  reload()
}

function exportBooklet() {
  const { filename, content } = exportDefectBooklet(filters)
  downloadTextFile(filename, content)
}

/* --------------------------------- 详情面板 --------------------------------- */

const detail = ref<DefectView | null>(null)
const dueDraft = ref('')
const measureDraft = ref('')

const canEditDue = computed(() =>
  detail.value ? store.canEditDueDate(String(detail.value['责任班组'] ?? '')) : false,
)

function openDetail(row: DefectView) {
  openDetailById(Number(row.id))
}

function openDetailById(id: number) {
  const view = getDefectView(id)
  if (!view) {
    detail.value = null
    return
  }
  detail.value = view
  dueDraft.value = view.要求完成日
  measureDraft.value = String(view['消缺措施'] ?? '')
}

function closeDetail() {
  detail.value = null
}

function saveDueDate() {
  if (!detail.value) {
    return
  }
  const result = updateDueDate(Number(detail.value.id), dueDraft.value, store.operator)
  flash(result.message)
  if (result.ok) {
    openDetailById(Number(detail.value.id))
    reload()
  }
}

function saveMeasure() {
  if (!detail.value) {
    return
  }
  const result = updateMeasure(Number(detail.value.id), measureDraft.value)
  flash(result.message)
  if (result.ok) {
    openDetailById(Number(detail.value.id))
    reload()
  }
}

/* --------------------------------- 闭环弹窗 --------------------------------- */

const closing = ref<DefectView | null>(null)
const closingId = ref<number | null>(null)
const usages = ref<SpareUsage[]>([])
const spareOptions = ref<EntryRow[]>([])

function beginClose(row: DefectView) {
  closing.value = row
  usages.value = [{ 备件编号: '', 备件名称: '', 数量: 1 }]
}

function cancelClose() {
  if (closingId.value !== null) {
    return
  }
  closing.value = null
  usages.value = []
}

function addUsage() {
  usages.value.push({ 备件编号: '', 备件名称: '', 数量: 1 })
}

function removeUsage(index: number) {
  usages.value.splice(index, 1)
}

function resolveUsages(): { items: SpareUsage[]; error?: string } {
  const items: SpareUsage[] = []
  for (const draft of usages.value) {
    const code = draft.备件编号.trim()
    if (!code) {
      continue
    }
    const spare = spareOptions.value.find((item) => String(item['备件编号']) === code)
    const quantity = Number(draft.数量)
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return { items: [], error: `备件「${code}」领用数量必须是正整数` }
    }
    items.push({
      备件编号: code,
      备件名称: spare ? String(spare['备件名称']) : code,
      数量: quantity,
    })
  }
  return { items }
}

function confirmClose() {
  if (!closing.value || closingId.value !== null) {
    return
  }
  const resolved = resolveUsages()
  if (resolved.error) {
    flash(resolved.error)
    return
  }
  const id = Number(closing.value.id)
  closingId.value = id
  try {
    const result = advanceDefect(id, '确认闭环', resolved.items)
    flash(result.message)
    if (result.ok) {
      closing.value = null
      usages.value = []
      detail.value = null
      reload()
    }
  } finally {
    closingId.value = null
  }
}

onMounted(() => {
  spareOptions.value = listRows('spare')
  reload()
})
</script>

<style scoped>
.page-actions {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.identity-pick {
  font-size: 12px;
  color: var(--muted);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.identity-pick select {
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.warn {
  color: #b42318;
}
.tag {
  display: inline-block;
  border-radius: 999px;
  padding: 1px 10px;
  font-size: 12px;
}
.tag-warn {
  background: #fef3f2;
  color: #b42318;
  border: 1px solid #fecdca;
}
.tag-muted {
  background: #f2f4f7;
  color: var(--muted);
  border: 1px solid var(--border);
}
.locked-hint {
  color: var(--muted);
  font-size: 12px;
}
.drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 24, 40, 0.45);
  display: flex;
  justify-content: flex-end;
  z-index: 20;
}
.drawer {
  width: 520px;
  max-width: 92vw;
  background: #fff;
  height: 100%;
  overflow-y: auto;
  padding: 16px 20px;
}
.drawer-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.drawer-head h3 {
  margin: 0;
  font-size: 16px;
}
.detail-grid {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 6px 12px;
  margin: 12px 0;
  font-size: 13px;
}
.detail-grid dt {
  color: var(--muted);
}
.detail-grid dd {
  margin: 0;
}
.detail-edit {
  border-top: 1px solid var(--border);
  padding-top: 10px;
  margin-top: 10px;
}
.detail-edit h4,
.close-usages h4 {
  margin: 0 0 8px;
  font-size: 13px;
}
.detail-edit textarea {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font: inherit;
}
.inline-form {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 6px;
}
.inline-form input[type='date'] {
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.hint {
  color: var(--muted);
  font-size: 12px;
  margin: 6px 0 0;
}
.usage-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
.usage-row select,
.usage-row input {
  flex: 1;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.usage-row input {
  max-width: 110px;
}
.drawer-foot {
  margin-top: 16px;
  text-align: right;
}
</style>
