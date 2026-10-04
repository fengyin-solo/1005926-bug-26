import {
  backfillCursor,
  commitBlob,
  listLedger,
  listRows,
  type DataBlob,
} from '@/data/local-store'
import type { ActionResult, BackfillCursor, EntryRow, LedgerRow, Operator } from '@/data/types'

/**
 * 缺陷消缺领域服务：列表、详情、导出、台账共用这一处口径。
 *
 * 状态只能顺流：待派发 → 消缺中 → 待验收 → 已闭环，回不到上一环，闭环后冻结。
 * 超期、待办、台账、补录都与状态在同一笔事务里提交，失败整笔回滚。
 */

const MODULE_KEY = 'defect'
const SPARE_KEY = 'spare'
const LEDGER_KEY = 'spareLedger'
const BACKFILL_KEY = 'defectDeadlineBackfill'

const STATUSES = ['待派发', '消缺中', '待验收', '已闭环'] as const
const CLOSED_STATUS = '已闭环'
const OPEN_STATUSES = ['待派发', '消缺中', '待验收']

/** 每个动作只允许从哪一环出发：不在表里的流转一律拒绝（顺流、不回退、不跳环）。 */
const TRANSITIONS: Record<string, { from: string; to: string; label: string }> = {
  派发消缺: { from: '待派发', to: '消缺中', label: '已派发' },
  提交验收: { from: '消缺中', to: '待验收', label: '已提交验收' },
  确认闭环: { from: '待验收', to: CLOSED_STATUS, label: '已闭环' },
}

/**
 * 超期口径（权衡后取最简、可复核的一条）：
 * 未闭环（待派发/消缺中/待验收）且要求完成日早于今天，即算超期；闭环当天即移出超期口径。
 * 已闭环记录冻结闭环当时的结论（abnormal 即“超期闭环”），不再随今天重算，历史保持原样。
 */

/** 要求完成日按发现方式补齐：不同发现方式给不同的消缺时限（自然日，从发现日期起算）。 */
const SLA_DAYS_BY_DISCOVERY: Record<string, number> = {
  告警转缺陷: 1,
  红外测温: 3,
  检修发现: 5,
  例行试验: 7,
  日常巡视: 10,
}
const DEFAULT_SLA_DAYS = 10

// ---------- 日期工具 ----------

export function today(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function isValidDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00`)
  next.setDate(next.getDate() + days)
  const month = `${next.getMonth() + 1}`.padStart(2, '0')
  const day = `${next.getDate()}`.padStart(2, '0')
  return `${next.getFullYear()}-${month}-${day}`
}

function dayBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00`)
  const b = Date.parse(`${to}T00:00:00`)
  return Math.round((b - a) / 86_400_000)
}

function slaDays(discovery: unknown): number {
  return SLA_DAYS_BY_DISCOVERY[String(discovery ?? '')] ?? DEFAULT_SLA_DAYS
}

/** 按发现方式推要求完成日：发现日期 + 对应时限；发现日期缺失时以今天为起点。 */
export function deadlineFor(discovery: unknown, foundDate: unknown, refDate = today()): string {
  const anchor = isValidDate(foundDate) ? foundDate : refDate
  return addDays(anchor, slaDays(discovery))
}

// ---------- 统一派生口径：列表、详情、导出都从这里取 ----------

export type DefectView = {
  row: EntryRow
  closed: boolean
  overdue: boolean
  overdueDays: number
  /** 超期文案：列表标记、详情面板、导出册子共用。 */
  overdueText: string
  deadlineMissing: boolean
  requiredSpareCode: string
  requiredSpareQty: number
}

function parseSpareRef(value: unknown): { code: string; qty: number } {
  const text = String(value ?? '').trim()
  if (!text) {
    return { code: '', qty: 0 }
  }
  const code = text.match(/[A-Z]{2,}-\d+/)?.[0] ?? ''
  const qty = Number(text.match(/[×x*]\s*(\d+)/)?.[1] ?? 1)
  return { code, qty: Number.isFinite(qty) && qty > 0 ? qty : 1 }
}

export function deriveDefect(row: EntryRow, refDate = today()): DefectView {
  const status = String(row.status ?? '')
  const closed = status === CLOSED_STATUS
  const deadline = row['要求完成日']
  const deadlineMissing = !isValidDate(deadline)
  let overdue = false
  let overdueDays = 0
  if (closed) {
    // 历史闭环结论冻结：只展示闭环当时记下的超期结论，不按今天重算。
    overdue = row.abnormal === true
    const finished = row['实际完成时间']
    if (overdue && isValidDate(finished) && isValidDate(deadline)) {
      overdueDays = Math.max(0, dayBetween(deadline, finished))
    }
  } else if (isValidDate(deadline)) {
    overdueDays = dayBetween(deadline, refDate)
    overdue = overdueDays > 0
  }
  let overdueText = '未超期'
  if (closed) {
    overdueText = overdue ? `超期${overdueDays}天闭环` : '按期闭环'
  } else if (deadlineMissing) {
    overdueText = '要求完成日待补齐'
  } else if (overdue) {
    overdueText = `超期${overdueDays}天`
  }
  const spare = parseSpareRef(row['需用备件'])
  return { row, closed, overdue, overdueDays, overdueText, deadlineMissing, requiredSpareCode: spare.code, requiredSpareQty: spare.qty }
}

// ---------- 老数据兼容：打开时把存量记录的待办/超期标记对齐到统一口径 ----------

let reconciled = false

function asRows(blob: DataBlob, key: string): EntryRow[] {
  return (blob[key] as EntryRow[] | undefined) ?? []
}

function asLedger(blob: DataBlob): LedgerRow[] {
  return (blob[LEDGER_KEY] as LedgerRow[] | undefined) ?? []
}

// ---------- 事务包装 ----------

function transact(mutate: (blob: DataBlob) => void): ActionResult {
  try {
    commitBlob(mutate)
    return { ok: true, message: '提交成功' }
  } catch (error) {
    // commitBlob 落库失败时已把内存缓存恢复到提交前：状态、计数、台账整笔退回。
    return {
      ok: false,
      message: `提交失败，已整笔回滚：${error instanceof Error ? error.message : '未知错误'}`,
    }
  }
}

function findRow(blob: DataBlob, id: number): EntryRow | undefined {
  return asRows(blob, MODULE_KEY).find((item) => Number(item.id) === id)
}

// ---------- 权限 ----------

/** 只有本责任班组的班长能改要求完成日；已闭环的谁都不能改。 */
export function canEditDeadline(operator: Operator, row: EntryRow): boolean {
  return (
    String(row.status) !== CLOSED_STATUS &&
    operator.role === '班长' &&
    operator.crew === String(row['责任班组'] ?? '')
  )
}

// ---------- 状态机：只许顺流，不许回退/跳环/重复闭环 ----------

function advance(id: number, action: keyof typeof TRANSITIONS, patch?: (row: EntryRow) => string | void): ActionResult {
  const rule = TRANSITIONS[action]
  const refDate = today()
  // 提交前先在当前数据上做业务校验，保证不会把半成品写进事务。
  const rowsNow = listRows(MODULE_KEY)
  const current = rowsNow.find((item) => Number(item.id) === id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的消缺任务` }
  }
  const status = String(current.status)
  if (status === CLOSED_STATUS) {
    // 已闭环：任何流转动作都拒绝，闭环结论不可再动。
    return { ok: false, duplicated: action === '确认闭环', message: '该消缺任务已闭环，不能再操作' }
  }
  if (status !== rule.from) {
    return { ok: false, message: `当前状态「${status}」不能执行「${action}」，消缺状态只能顺着流转` }
  }
  const patchMessage = patch?.(current)
  if (typeof patchMessage === 'string') {
    return { ok: false, message: patchMessage }
  }
  const result = transact((blob) => {
    const rows = asRows(blob, MODULE_KEY)
    const row = rows.find((item) => Number(item.id) === id)
    if (!row || String(row.status) !== rule.from) {
      // 事务内二次确认：防止并发/重复点击抢跑。
      throw new Error('状态已变化，请刷新后重试')
    }
    patch?.(row)
    row.status = rule.to
    row['消缺状态'] = rule.to
    row.pending = rule.to !== CLOSED_STATUS
    if (rule.to !== CLOSED_STATUS) {
      const deadline = row['要求完成日']
      row.abnormal = isValidDate(deadline) ? dayBetween(deadline, refDate) > 0 : false
    }
  })
  if (!result.ok) {
    return result
  }
  return { ok: true, message: `消缺任务${rule.label}，当前状态「${rule.to}」` }
}

export function dispatchDefect(id: number): ActionResult {
  return advance(id, '派发消缺')
}

export function submitDefect(id: number): ActionResult {
  return advance(id, '提交验收', (row) => {
    if (!String(row['消缺措施'] ?? '').trim()) {
      return '请先填写消缺措施，再提交验收'
    }
  })
}

/**
 * 确认闭环：超期计数/标记、实际完成时间、闭环结论、备品待领用台账在同一笔事务里提交。
 * 连着点两次：第二次读到的已是「已闭环」，直接按幂等成功返回，台账不会重复登记。
 */
export function closeDefect(id: number, operator: Operator, actualFinishedDate?: string): ActionResult {
  const finished = isValidDate(actualFinishedDate) ? actualFinishedDate : today()
  const rowsNow = listRows(MODULE_KEY)
  const current = rowsNow.find((item) => Number(item.id) === id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的消缺任务` }
  }
  const status = String(current.status)
  if (status === CLOSED_STATUS) {
    // 幂等：重复确认闭环只算一次，不再改数据、不再登记台账。
    return { ok: true, duplicated: true, message: '该消缺任务已闭环，重复确认未重复记账' }
  }
  if (status !== '待验收') {
    return { ok: false, message: `当前状态「${status}」不能确认闭环，请先按顺序提交验收` }
  }
  const measure = String(current['消缺措施'] ?? '').trim()
  if (!measure) {
    return { ok: false, message: '请先补全消缺措施，再确认闭环' }
  }
  const foundDate = current['发现日期']
  if (isValidDate(foundDate) && finished < foundDate) {
    return { ok: false, message: `实际完成时间不能早于发现日期（${foundDate}）` }
  }
  const deadline = current['要求完成日']
  if (!isValidDate(deadline)) {
    return { ok: false, message: '要求完成日缺失，请由本责任班组班长补齐后再闭环' }
  }
  const closedOverdue = finished > deadline
  const overdueDays = Math.max(0, dayBetween(deadline, finished))
  const spareRef = parseSpareRef(current['需用备件'])
  const spareRow = spareRef.code
    ? listRows(SPARE_KEY).find((item) => String(item['备件编号']) === spareRef.code)
    : undefined
  if (spareRef.code && !spareRow) {
    return { ok: false, message: `需用备件 ${spareRef.code} 在备品台账里不存在，请核对后再闭环` }
  }
  const conclusion = closedOverdue
    ? `${measure}；实际完成时间 ${finished}，超期${overdueDays}天闭环。`
    : `${measure}；实际完成时间 ${finished}，按期闭环。`

  const result = transact((blob) => {
    const rows = asRows(blob, MODULE_KEY)
    const row = rows.find((item) => Number(item.id) === id)
    if (!row || String(row.status) !== '待验收') {
      throw new Error('状态已变化，请刷新后重试')
    }
    row.status = CLOSED_STATUS
    row['消缺状态'] = CLOSED_STATUS
    row.pending = false
    // 超期标记随状态一起落：闭环是否超期按“实际完成时间 vs 要求完成日”冻结。
    row.abnormal = closedOverdue
    row['实际完成时间'] = finished
    row['闭环结论'] = conclusion

    // 闭环结论回写备品备件待领用台账（同一笔事务，失败一起退回）。
    if (spareRef.code && spareRow) {
      const ledger = asLedger(blob)
      const code = String(row['缺陷编号'])
      const existing = ledger.find((item) => item.缺陷编号 === code && item.状态 === '待领用')
      if (existing) {
        existing.闭环结论 = conclusion
        existing.备件名称 = String(spareRow['备件名称'])
        existing.规格型号 = String(spareRow['规格型号'])
        existing.责任班组 = String(row['责任班组'] ?? existing.责任班组)
      } else {
        const nextId = ledger.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
        ledger.push({
          id: nextId,
          备件编号: spareRef.code,
          备件名称: String(spareRow['备件名称'] ?? ''),
          规格型号: String(spareRow['规格型号'] ?? ''),
          数量: spareRef.qty,
          缺陷编号: code,
          责任班组: String(row['责任班组'] ?? ''),
          登记时间: finished,
          状态: '待领用',
          闭环结论: conclusion,
        })
      }
    }
  })
  if (!result.ok) {
    return result
  }
  const operatorName = operator.name ? `（${operator.name}）` : ''
  return {
    ok: true,
    message: closedOverdue
      ? `消缺任务已闭环${operatorName}：实际完成晚于要求完成日，按超期${overdueDays}天冻结结论${spareRef.code ? '，待领用台账已登记' : ''}`
      : `消缺任务已按期闭环${operatorName}${spareRef.code ? '，待领用台账已登记' : ''}`,
  }
}

// ---------- 要求完成日 / 消缺措施 ----------

export function updateDeadline(id: number, value: string, operator: Operator): ActionResult {
  if (!isValidDate(value)) {
    return { ok: false, message: '要求完成日需为 YYYY-MM-DD 格式的有效日期' }
  }
  const current = listRows(MODULE_KEY).find((item) => Number(item.id) === id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的消缺任务` }
  }
  if (String(current.status) === CLOSED_STATUS) {
    return { ok: false, message: '已闭环的消缺任务不能修改要求完成日' }
  }
  if (operator.role !== '班长') {
    return { ok: false, message: '只有班长才能修改要求完成日' }
  }
  if (operator.crew !== String(current['责任班组'] ?? '')) {
    return { ok: false, message: `只有本责任班组（${current['责任班组']}）的班长才能修改要求完成日` }
  }
  const foundDate = current['发现日期']
  if (isValidDate(foundDate) && value < foundDate) {
    return { ok: false, message: `要求完成日不能早于发现日期（${foundDate}）` }
  }
  const refDate = today()
  const result = transact((blob) => {
    const row = findRow(blob, id)
    if (!row || String(row.status) === CLOSED_STATUS) {
      throw new Error('状态已变化，修改已取消')
    }
    row['要求完成日'] = value
    // 超期计数随要求完成日一起变更。
    row.abnormal = dayBetween(value, refDate) > 0
    row.pending = true
  })
  if (!result.ok) {
    return result
  }
  return { ok: true, message: `要求完成日已改为 ${value}，超期标记已同步重算` }
}

/** 消缺措施：未闭环可维护；已闭环冻结，谁都不许再动。 */
export function updateMeasure(id: number, value: string, operator: Operator): ActionResult {
  const current = listRows(MODULE_KEY).find((item) => Number(item.id) === id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的消缺任务` }
  }
  if (String(current.status) === CLOSED_STATUS) {
    return { ok: false, message: '已闭环的消缺任务不能修改消缺措施' }
  }
  if (!operator.name) {
    return { ok: false, message: '请先选择值班身份' }
  }
  const result = transact((blob) => {
    const row = findRow(blob, id)
    if (!row || String(row.status) === CLOSED_STATUS) {
      throw new Error('状态已变化，修改已取消')
    }
    row['消缺措施'] = value
  })
  return result.ok ? { ok: true, message: '消缺措施已保存' } : result
}

/** 需用备件（如 SPAR-0001 ×3）：闭环时据此回写待领用台账；同样不许在闭环后改动。 */
export function updateRequiredSpare(id: number, value: string, operator: Operator): ActionResult {
  const current = listRows(MODULE_KEY).find((item) => Number(item.id) === id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的消缺任务` }
  }
  if (String(current.status) === CLOSED_STATUS) {
    return { ok: false, message: '已闭环的消缺任务不能修改需用备件' }
  }
  if (!operator.name) {
    return { ok: false, message: '请先选择值班身份' }
  }
  const ref = parseSpareRef(value)
  const trimmed = value.trim()
  if (trimmed && !ref.code) {
    return { ok: false, message: '需用备件格式示例：SPAR-0001 ×3（备件编号 + 可选数量）' }
  }
  if (ref.code && !listRows(SPARE_KEY).some((item) => String(item['备件编号']) === ref.code)) {
    return { ok: false, message: `备件编号 ${ref.code} 不在备品台账里` }
  }
  const result = transact((blob) => {
    const row = findRow(blob, id)
    if (!row || String(row.status) === CLOSED_STATUS) {
      throw new Error('状态已变化，修改已取消')
    }
    row['需用备件'] = trimmed
  })
  return result.ok ? { ok: true, message: '需用备件已保存，闭环时回写待领用台账' } : result
}

// ---------- 要求完成日补录：按发现方式补齐，中断后从断点继续 ----------

export type BackfillResult = ActionResult & { remaining: number; filled?: string }

/**
 * 每次补一条（点击一次补一条）：已处理的缺陷 id 记账，
 * 中途关掉/刷新/落库失败都不会重复补，下次从断点接着往下补。
 */
export function backfillDeadlineStep(): BackfillResult {
  const refDate = today()
  const rowsNow = listRows(MODULE_KEY)
  const cursor = backfillCursor()
  const target = rowsNow
    .filter((row) => String(row.status) !== CLOSED_STATUS && !isValidDate(row['要求完成日']) && !cursor.done.includes(Number(row.id)))
    .sort((a, b) => Number(a.id) - Number(b.id))[0]
  if (!target) {
    return { ok: true, message: '要求完成日已全部补齐', remaining: 0 }
  }
  const id = Number(target.id)
  const deadline = deadlineFor(target['发现方式'], target['发现日期'], refDate)
  const result = transact((blob) => {
    const row = asRows(blob, MODULE_KEY).find((item) => Number(item.id) === id)
    const progress = (blob[BACKFILL_KEY] as BackfillCursor | undefined) ?? { done: [] }
    if (!row || isValidDate(row['要求完成日']) || progress.done.includes(id)) {
      throw new Error('该条已补齐，请继续下一条')
    }
    row['要求完成日'] = deadline
    row.abnormal = dayBetween(deadline, refDate) > 0
    progress.done = [...progress.done, id]
    blob[BACKFILL_KEY] = progress
  })
  const remaining = rowsNow.filter(
    (row) => String(row.status) !== CLOSED_STATUS && !isValidDate(row['要求完成日']) && Number(row.id) !== id,
  ).length
  if (!result.ok) {
    return { ...result, remaining }
  }
  return {
    ok: true,
    filled: String(target['缺陷编号']),
    remaining,
    message: `${target['缺陷编号']} 已按「${target['发现方式']}」时限补齐要求完成日 ${deadline}，还剩 ${remaining} 条待补`,
  }
}

export function backfillRemaining(): number {
  const cursor = backfillCursor()
  return listRows(MODULE_KEY).filter(
    (row) => String(row.status) !== CLOSED_STATUS && !isValidDate(row['要求完成日']) && !cursor.done.includes(Number(row.id)),
  ).length
}

// ---------- 读取：列表 / 统计 / 详情 / 导出 ----------

function matchesFilters(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) => pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())))
}

export function listDefects(filters: Record<string, string> = {}): EntryRow[] {
  reconcile()
  return matchesFilters(listRows(MODULE_KEY), filters)
}

function reconcile(): void {
  if (reconciled) {
    return
  }
  const refDate = today()
  const rowsNow = listRows(MODULE_KEY)
  const needWrite = rowsNow.some((row) => {
    const view = deriveDefect(row, refDate)
    return (
      (!view.closed && (row.pending !== true || row.abnormal !== view.overdue)) ||
      String(row['消缺状态'] ?? '') !== String(row.status ?? '')
    )
  })
  if (!needWrite) {
    reconciled = true
    return
  }
  const result = transact((blob) => {
    const rows = asRows(blob, MODULE_KEY)
    for (const row of rows) {
      const view = deriveDefect(row, refDate)
      if (view.closed) {
        continue
      }
      row.pending = true
      row.abnormal = view.overdue
      row['消缺状态'] = String(row.status ?? '')
    }
  })
  reconciled = result.ok
  if (!result.ok && typeof console !== 'undefined') {
    // 兼容校准落库失败不应阻断页面读取；下一次读取仍会重试。
    console.warn(result.message)
  }
}

export type DefectStats = {
  pendingDispatch: number
  fixing: number
  pendingAcceptance: number
  overdueOpen: number
  active: number
  closed: number
}

export function defectStats(filters: Record<string, string> = {}, refDate = today()): DefectStats {
  const rows = listDefects(filters).map((row) => deriveDefect(row, refDate))
  return {
    pendingDispatch: rows.filter((item) => item.row.status === '待派发').length,
    fixing: rows.filter((item) => item.row.status === '消缺中').length,
    pendingAcceptance: rows.filter((item) => item.row.status === '待验收').length,
    overdueOpen: rows.filter((item) => !item.closed && item.overdue).length,
    active: rows.filter((item) => !item.closed).length,
    closed: rows.filter((item) => item.closed).length,
  }
}

/** 在办缺陷数：缺陷页与备品页共用这一个口径，两处必须对得上。 */
export function activeDefectCount(): number {
  reconcile()
  return listRows(MODULE_KEY).filter((row) => String(row.status) !== CLOSED_STATUS).length
}

/** 供概览等通用页面触发统一口径校准。 */
export function reconcileDefectRead(): void {
  reconcile()
}

export function defectDetail(id: number): DefectView | undefined {
  reconcile()
  const row = listRows(MODULE_KEY).find((item) => Number(item.id) === id)
  return row ? deriveDefect(row) : undefined
}

// ---------- 导出册子：与列表、详情同一套算法 ----------

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function exportDefectsCsv(filters: Record<string, string> = {}): { filename: string; content: string } {
  const header = [
    '缺陷编号', '缺陷类别', '发现方式', '严重等级', '责任班组', '发现日期',
    '要求完成日', '实际完成时间', '当前状态', '超期结论', '消缺措施', '闭环结论',
  ]
  const lines = [header.join(',')]
  for (const view of listDefects(filters).map((row) => deriveDefect(row))) {
    const { row } = view
    lines.push(
      [
        row['缺陷编号'], row['缺陷类别'], row['发现方式'], row['严重等级'], row['责任班组'],
        row['发现日期'], row['要求完成日'], row['实际完成时间'], row.status,
        view.overdueText, row['消缺措施'], view.closed ? row['闭环结论'] : '',
      ].map(csvCell).join(','),
    )
  }
  return { filename: '缺陷消缺-闭环册子.csv', content: `﻿${lines.join('\n')}` }
}

// ---------- 备品备件待领用台账 ----------

export function listPendingLedger(): LedgerRow[] {
  return listLedger().filter((item) => item.状态 === '待领用')
}

export function ledgerForDefect(defectCode: string): LedgerRow | undefined {
  return listLedger().find((item) => item.缺陷编号 === defectCode)
}

/** 待领用台账办理领用：只改台账，不动已闭环的缺陷结论。 */
export function receiveLedger(id: number): ActionResult {
  const current = listLedger().find((item) => Number(item.id) === id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的台账记录` }
  }
  if (current.状态 === '已领用') {
    return { ok: true, duplicated: true, message: '该备件已办理领用，未重复办理' }
  }
  const result = transact((blob) => {
    const row = asLedger(blob).find((item) => Number(item.id) === id)
    if (!row || row.状态 === '已领用') {
      throw new Error('台账状态已变化，请刷新后重试')
    }
    row.状态 = '已领用'
    row.领用时间 = today()
  })
  return result.ok ? { ok: true, message: `${current['备件编号']} 已办理领用` } : result
}

// 供状态机/视图复用
export const DEFECT_CONST = { STATUSES, OPEN_STATUSES, CLOSED_STATUS, SLA_DAYS_BY_DISCOVERY }
