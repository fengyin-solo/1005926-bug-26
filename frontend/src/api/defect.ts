import { commit, listRows, SPARE_LEDGER_KEY } from '@/data/local-store'
import type {
  ActionResult,
  BackfillResult,
  EntryRow,
  Operator,
  SpareLedgerRow,
  SpareUsage,
} from '@/data/types'

/**
 * 消缺闭环领域服务。
 * 列表、详情面板、另存册子一律走 viewDefect 这一个口径算超期；
 * 所有写操作都在内存快照上改完后经 commit 一次性落库，落库失败保持原缓存，整笔回滚。
 */

const DEFECT_KEY = 'defect'

// 状态只能顺着流转：待派发 → 消缺中 → 待验收 → 已闭环，到了已闭环就是终态。
const DEFECT_STATUSES = ['待派发', '消缺中', '待验收', '已闭环'] as const
const CLOSED_STATUS = '已闭环'
const ACTION_NEXT: Record<string, (typeof DEFECT_STATUSES)[number]> = {
  派发消缺: '消缺中',
  提交验收: '待验收',
  确认闭环: '已闭环',
}

// 要求完成日按发现方式给的消缺时限（自然日）。
const SLA_DAYS_BY_FOUND: Array<[string[], number]> = [
  [['告警触发', '在线监测'], 3],
  [['例行巡视', '定期巡检', '特殊巡视'], 7],
  [['检修发现', '维护发现'], 15],
]
const DEFAULT_SLA_DAYS = 7
// 老记录没有发现日期时用的兜底基准，保证补录结果可重现、与今天无关。
const LEGACY_FOUND_FALLBACK = '2026-09-01'

// 连续点确认闭环的在途锁：同一缺陷一笔闭环没走完，第二下直接挡回去。
const inflightClose = new Set<number>()

/* ---------------------------------- 日期工具 ---------------------------------- */

function parseDay(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null
  }
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!matched) {
    return null
  }
  const time = Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]))
  return Number.isNaN(time) ? null : time
}

const DAY_MS = 24 * 60 * 60 * 1000

function addDays(day: number, days: number): string {
  const date = new Date(day + days * DAY_MS)
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function todayDay(): number {
  const now = new Date()
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
}

function nowStamp(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

function slaDays(foundBy: unknown): number {
  const label = String(foundBy ?? '').trim()
  const hit = SLA_DAYS_BY_FOUND.find(([keys]) => keys.includes(label))
  return hit ? hit[1] : DEFAULT_SLA_DAYS
}

/* --------------------------------- 超期唯一口径 --------------------------------- */

/**
 * 在办缺陷的超期判定（列表/统计/详情/册子共用）：
 * 未闭环 + 要求完成日是合法日期 + 要求完成日早于今天。已闭环一律不再算超期；
 * 要求完成日缺失或认不出来的既有记录按未超期处理，等补录后自动纳入。
 */
function isOpenOverdue(row: EntryRow, today: number = todayDay()): boolean {
  if (String(row.status) === CLOSED_STATUS) {
    return false
  }
  const due = parseDay(row['要求完成日'])
  return due !== null && due < today
}

/**
 * 已闭环缺陷的闭环结论：只认闭环当时落库的快照「闭环超期」。
 * 历史老记录没有这个快照字段的，保持原样、按「按时闭环」展示，绝不用新算法翻旧账。
 */
function closureOverdue(row: EntryRow): boolean {
  const snapshot = row['闭环超期']
  return typeof snapshot === 'boolean' ? snapshot : false
}

export type DefectView = EntryRow & {
  在办: boolean
  超期: boolean
  超期标记: string
  闭环结论: string
  要求完成日: string
  实际完成时间: string
}

export function viewDefect(row: EntryRow, today: number = todayDay()): DefectView {
  const closed = String(row.status) === CLOSED_STATUS
  const overdue = closed ? closureOverdue(row) : isOpenOverdue(row, today)
  return {
    ...row,
    在办: !closed,
    超期: overdue,
    超期标记: overdue ? (closed ? '闭环超期' : '超期') : '',
    闭环结论: closed ? (overdue ? '超期闭环' : '按时闭环') : '',
    要求完成日: String(row['要求完成日'] ?? ''),
    实际完成时间: String(row['实际完成时间'] ?? ''),
  }
}

function listDefects(): EntryRow[] {
  return listRows(DEFECT_KEY)
}

function findDefect(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}

export function listDefectViews(
  filters: Record<string, string> = {},
): { items: DefectView[]; total: number } {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  const views = listDefects()
    .filter((row) =>
      pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
    )
    .map((row) => viewDefect(row))
  return { items: views, total: views.length }
}

export function getDefectView(id: number): DefectView | null {
  const row = findDefect(listDefects(), id)
  return row ? viewDefect(row) : null
}

export type DefectStats = {
  pendingDispatch: number
  inProgress: number
  active: number
  overdueOpen: number
}

/** 在办缺陷数：未闭环的都算，备品备件页用同一个函数，两边口径天然一致。 */
export function activeDefectCount(): number {
  return listDefects().filter((row) => String(row.status) !== CLOSED_STATUS).length
}

export function defectStats(today: number = todayDay()): DefectStats {
  const rows = listDefects()
  return {
    pendingDispatch: rows.filter((row) => String(row.status) === '待派发').length,
    inProgress: rows.filter((row) => String(row.status) === '消缺中').length,
    active: rows.filter((row) => String(row.status) !== CLOSED_STATUS).length,
    overdueOpen: rows.filter((row) => isOpenOverdue(row, today)).length,
  }
}

/* ---------------------------------- 状态流转 ---------------------------------- */

function fail(message: string): ActionResult {
  return { ok: false, message }
}

/**
 * 顺着流转一个状态。确认闭环时可带备件领用清单，与状态、超期结论、实际完成时间
 * 同一事务落库；任何一步不满足或落库失败，整笔回退。
 */
export function advanceDefect(id: number, action: string, usages: SpareUsage[] = []): ActionResult {
  const target = ACTION_NEXT[action]
  if (!target) {
    return fail(`消缺任务没有登记「${action}」这个动作`)
  }
  if (action === '确认闭环' && inflightClose.has(id)) {
    return fail('该缺陷正在闭环，请勿重复提交')
  }

  const rows = listDefects()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的消缺任务`)
  }
  const current = String(rows[index].status)
  if (current === CLOSED_STATUS) {
    // 连着点第二次确认闭环：幂等返回，状态、台账都不再记第二笔。
    if (action === '确认闭环') {
      return { ok: true, message: '该消缺任务已闭环，本次点击未重复计账' }
    }
    return fail('该消缺任务已闭环，闭环结论不能改动')
  }
  // 只能走到紧邻的下一环，跳环、回环都不允许。
  const currentIndex = DEFECT_STATUSES.indexOf(current as (typeof DEFECT_STATUSES)[number])
  const expected = DEFECT_STATUSES[currentIndex + 1]
  if (target !== expected) {
    return fail(`消缺任务当前为「${current}」，不能直接执行「${action}」，状态只能逐环向前流转`)
  }

  const closing = target === CLOSED_STATUS
  if (closing) {
    inflightClose.add(id)
  }
  try {
    const today = todayDay()
    const updated: EntryRow = {
      ...rows[index],
      status: target,
      pending: target !== CLOSED_STATUS,
      // 超期标记随状态一起重算：闭环后在办超期立即摘除，不留残留。
      abnormal: closing ? false : isOpenOverdue(rows[index], today),
    }
    if (closing) {
      const due = parseDay(rows[index]['要求完成日'])
      const finished = addDays(today, 0)
      updated['实际完成时间'] = finished
      // 闭环当时的超期结论固化成快照，今后历史结论不再随算法或今天变化。
      updated['闭环超期'] = due !== null ? due < today : false
    }

    const nextRows = [...rows]
    nextRows[index] = updated

    const changes: Record<string, EntryRow[]> = { [DEFECT_KEY]: nextRows }
    if (closing) {
      const ledgerChanges = buildLedgerChanges(listRows(SPARE_LEDGER_KEY), updated, usages)
      if (ledgerChanges.error) {
        return fail(ledgerChanges.error)
      }
      if (ledgerChanges.value) {
        changes[SPARE_LEDGER_KEY] = ledgerChanges.value
      }
    }

    try {
      commit(changes)
    } catch (error) {
      // 落库失败：缓存没动，状态、台账整笔都还在提交前。
      return fail(`落库失败，已整笔回滚：${error instanceof Error ? error.message : '未知错误'}`)
    }
    return {
      ok: true,
      message: closing
        ? `消缺任务已闭环，闭环结论「${updated['闭环超期'] ? '超期闭环' : '按时闭环'}」，待领用台账已同步`
        : `消缺任务已${action}，当前状态「${target}」`,
    }
  } finally {
    inflightClose.delete(id)
  }
}

function buildLedgerChanges(
  ledger: EntryRow[],
  defect: EntryRow,
  usages: SpareUsage[],
): { value: SpareLedgerRow[] | null; error?: string } {
  const valid = usages.filter((item) => item.备件编号.trim() !== '' && Number(item.数量) > 0)
  if (valid.length === 0) {
    return { value: null }
  }
  // 同一备件合并成一行，连点或多分录都不会重复挂账。
  const merged = new Map<string, { 备件编号: string; 备件名称: string; 数量: number }>()
  for (const item of valid) {
    const code = item.备件编号.trim()
    const prev = merged.get(code)
    if (prev) {
      prev.数量 += Number(item.数量)
    } else {
      merged.set(code, {
        备件编号: code,
        备件名称: item.备件名称.trim() || code,
        数量: Number(item.数量),
      })
    }
  }
  const stamp = nowStamp()
  let nextId = ledger.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  const additions: SpareLedgerRow[] = [...merged.values()].map((item) => {
    nextId += 1
    return {
      id: nextId,
      status: '待领用',
      pending: true,
      abnormal: false,
      defectId: Number(defect.id),
      缺陷编号: String(defect['缺陷编号'] ?? defect.id),
      备件编号: item.备件编号,
      备件名称: item.备件名称,
      数量: item.数量,
      责任班组: String(defect['责任班组'] ?? ''),
      登记时间: stamp,
      状态: '待领用',
    }
  })
  return { value: [...ledger, ...additions] as SpareLedgerRow[] }
}

/* --------------------------------- 字段级修改 --------------------------------- */

/** 改要求完成日：仅本责任班组班长可改；已闭环记录锁定；改完超期标记同步重算，单表单事务。 */
export function updateDueDate(id: number, dueDate: string, operator: Operator): ActionResult {
  const rows = listDefects()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的消缺任务`)
  }
  const row = rows[index]
  if (String(row.status) === CLOSED_STATUS) {
    return fail('消缺任务已闭环，要求完成日与闭环结论均不能改动')
  }
  const crew = String(row['责任班组'] ?? '')
  if (operator.role !== '班长' || operator.crew !== crew) {
    return fail(`只有「${crew}」的班长才能修改要求完成日`)
  }
  if (parseDay(dueDate) === null) {
    return fail('要求完成日必须是 YYYY-MM-DD 格式的合法日期')
  }
  const updated: EntryRow = {
    ...row,
    要求完成日: dueDate.trim(),
    abnormal: parseDay(dueDate)! < todayDay(),
  }
  const nextRows = [...rows]
  nextRows[index] = updated
  try {
    commit({ [DEFECT_KEY]: nextRows })
  } catch (error) {
    return fail(`落库失败，已整笔回滚：${error instanceof Error ? error.message : '未知错误'}`)
  }
  return { ok: true, message: '要求完成日已更新，超期标记已同步重算' }
}

/** 改消缺措施：已闭环不许再动。 */
export function updateMeasure(id: number, measure: string): ActionResult {
  const trimmed = measure.trim()
  if (!trimmed) {
    return fail('消缺措施不能为空')
  }
  const rows = listDefects()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的消缺任务`)
  }
  if (String(rows[index].status) === CLOSED_STATUS) {
    return fail('消缺任务已闭环，消缺措施锁定，不能再改动')
  }
  const nextRows = [...rows]
  nextRows[index] = { ...rows[index], 消缺措施: trimmed }
  try {
    commit({ [DEFECT_KEY]: nextRows })
  } catch (error) {
    return fail(`落库失败，已整笔回滚：${error instanceof Error ? error.message : '未知错误'}`)
  }
  return { ok: true, message: '消缺措施已更新' }
}

/* ------------------------------ 要求完成日批量补录 ------------------------------ */

/**
 * 按发现方式补齐缺失的要求完成日（发现日期 + 对应时限）。
 * 每条缺陷独立一个事务提交：补成一条落一条，中途失败/关掉页面，下次再点只处理
 * 仍缺要求完成日的记录，接着往下补，不会重复补已补过的。
 */
export function backfillDueDates(): BackfillResult {
  const targets = [...listDefects()]
    .filter((row) => parseDay(row['要求完成日']) === null)
    .sort((a, b) => Number(a.id) - Number(b.id))

  let filled = 0
  for (const row of targets) {
    const foundDay = parseDay(row['发现日期']) ?? parseDay(LEGACY_FOUND_FALLBACK)!
    const dueDate = addDays(foundDay, slaDays(row['发现方式']))
    const nextRows = listDefects().map((item) =>
      Number(item.id) === Number(row.id)
        ? {
            ...item,
            要求完成日: dueDate,
            abnormal:
              String(item.status) !== CLOSED_STATUS && parseDay(dueDate)! < todayDay(),
          }
        : item,
    )
    try {
      commit({ [DEFECT_KEY]: nextRows })
    } catch (error) {
      return {
        ok: false,
        filled,
        remaining: targets.length - filled,
        failedAt: Number(row.id),
        message: `第 ${filled + 1} 条（缺陷 ${row['缺陷编号'] ?? row.id}）落库失败，已暂停，已补 ${filled} 条；稍后重试会从这条继续`,
      }
    }
    filled += 1
  }
  return {
    ok: true,
    filled,
    remaining: 0,
    message: filled === 0 ? '没有需要补录的缺陷' : `补录完成，共补齐 ${filled} 条要求完成日`,
  }
}

/* ------------------------------ 备品备件待领用台账 ------------------------------ */

export function listLedger(): SpareLedgerRow[] {
  return listRows(SPARE_LEDGER_KEY) as SpareLedgerRow[]
}

export function ledgerPendingCount(): number {
  return listLedger().filter((row) => String(row['状态'] ?? row.status) === '待领用').length
}

/* --------------------------------- 另存缺陷册子 --------------------------------- */

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 册子与详情、列表同源：逐行走 viewDefect，超期口径不会出现第二套算法。 */
export function exportDefectBooklet(filters: Record<string, string> = {}): {
  filename: string
  content: string
} {
  const { items } = listDefectViews(filters)
  const header = [
    '缺陷编号',
    '缺陷类别',
    '发现方式',
    '严重等级',
    '责任班组',
    '发现日期',
    '要求完成日',
    '消缺措施',
    '消缺状态',
    '实际完成时间',
    '超期标记',
    '闭环结论',
  ]
  const lines = [header.join(',')]
  for (const row of items) {
    lines.push(
      [
        row['缺陷编号'],
        row['缺陷类别'],
        row['发现方式'],
        row['严重等级'],
        row['责任班组'],
        row['发现日期'],
        row.要求完成日,
        row['消缺措施'],
        row.status,
        row.实际完成时间,
        row.超期标记,
        row.闭环结论,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return { filename: '缺陷消缺闭环册子.csv', content: `\uFEFF${lines.join('\n')}` }
}

export function downloadTextFile(filename: string, content: string): void {
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
