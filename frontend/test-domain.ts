/* 领域规则端到端验证（Node + localStorage 垫片，不进 src 构建）。 */
import assert from 'node:assert'

// ---- 浏览器垫片 ----
const memory = new Map<string, string>()
const storage = {
  getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
  setItem: (k: string, v: string) => {
    memory.set(k, v)
  },
  removeItem: (k: string) => {
    memory.delete(k)
  },
}
;(globalThis as any).window = globalThis
;(globalThis as any).localStorage = storage
;(globalThis as any).Blob = class {}
;(globalThis as any).URL = { createObjectURL: () => '', revokeObjectURL: () => {} }
;(globalThis as any).document = { createElement: () => ({}), body: { appendChild() {}, removeChild() {} } }

import {
  activeDefectCount,
  advanceDefect,
  backfillDueDates,
  defectStats,
  exportDefectBooklet,
  getDefectView,
  ledgerPendingCount,
  listDefectViews,
  listLedger,
  updateDueDate,
  updateMeasure,
} from '@/api/defect'
import { allRows, commit } from '@/data/local-store'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`✓ ${name}`)
}

const 班长一班 = { name: '张班长', role: '班长' as const, crew: '光伏一班' }
const 班长二班 = { name: '李班长', role: '班长' as const, crew: '光伏二班' }
const 班员一班 = { name: '王小虎', role: '班员' as const, crew: '光伏一班' }

function row(id: number) {
  const view = getDefectView(id)
  if (!view) throw new Error(`缺缺陷 ${id}`)
  return view
}

// 初始统计：id1(待派发,09-27)、id2(消缺中,10-03) 超期；id3(待验收,10-04=今天) 不超期；在办 1/2/3/7
check('初始超期未闭环=2，在办=4（在办口径=未闭环）', () => {
  const s = defectStats()
  assert.equal(s.overdueOpen, 2)
  assert.equal(s.active, 4)
  assert.equal(activeDefectCount(), 4)
})

check('状态只能顺着走：待派发不能直接确认闭环/提交验收', () => {
  assert.equal(advanceDefect(1, '确认闭环').ok, false)
  assert.equal(advanceDefect(1, '提交验收').ok, false)
  assert.equal(row(1).status, '待派发')
})

check('消缺中不能回退到派发，只能提交验收', () => {
  assert.equal(advanceDefect(2, '派发消缺').ok, false)
  assert.equal(advanceDefect(2, '提交验收').ok, true)
  assert.equal(row(2).status, '待验收')
})

check('权限：只有本责任班组班长能改要求完成日', () => {
  assert.equal(updateDueDate(1, '2026-10-10', 班员一班).ok, false)
  assert.equal(updateDueDate(1, '2026-10-10', 班长二班).ok, false)
  assert.equal(updateDueDate(1, 'bad-date', 班长一班).ok, false)
  assert.equal(updateDueDate(1, '2026-10-10', 班长一班).ok, true)
  assert.equal(row(1).要求完成日, '2026-10-10')
  assert.equal(row(1).超期, false) // 改到未来后超期标记随状态同步摘除
  assert.equal(defectStats().overdueOpen, 1)
})

check('改要求完成日到过去：超期标记同步置回', () => {
  assert.equal(updateDueDate(1, '2026-09-30', 班长一班).ok, true)
  assert.equal(row(1).超期, true)
})

// 正常闭环 id3：要求完成日=今天 → 按时闭环；实际完成时间补录为今天
check('确认闭环：状态终态、实际完成时间=2026-10-04、按时闭环、超期计数摘除', () => {
  const beforeLedger = listLedger().length
  const r = advanceDefect(3, '确认闭环', [
    { 备件编号: 'SPAR-FUSE-10', 备件名称: '直流熔断器 15A', 数量: 2 },
    { 备件编号: 'SPAR-FUSE-10', 备件名称: '直流熔断器 15A', 数量: 3 },
  ])
  assert.equal(r.ok, true, r.message)
  const v = row(3)
  assert.equal(v.status, '已闭环')
  assert.equal(v.实际完成时间, '2026-10-04')
  assert.equal(v.闭环结论, '按时闭环')
  assert.equal(v.超期, false)
  assert.equal(v.超期标记, '')
  // 同备件两行合并成一行 2+3=5
  const ledgerRows = listLedger()
  assert.equal(ledgerRows.length, beforeLedger + 1)
  assert.equal(ledgerRows.at(-1)!.数量, 5)
  assert.equal(ledgerRows.at(-1)!.状态, '待领用')
  assert.equal(ledgerRows.at(-1)!.缺陷编号, 'DEFE-2026-0003')
  assert.equal(ledgerPendingCount(), 2)
  // 在办数两边同口径：缺陷侧少一条
  assert.equal(activeDefectCount(), 3)
  assert.equal(defectStats().active, 3)
})

check('连着点第二次确认闭环只算一次：幂等成功、台账不重复', () => {
  const before = listLedger().length
  const r = advanceDefect(3, '确认闭环', [
    { 备件编号: 'SPAR-FUSE-10', 备件名称: 'x', 数量: 9 },
  ])
  assert.equal(r.ok, true)
  assert.equal(listLedger().length, before)
  assert.equal(row(3).实际完成时间, '2026-10-04')
})

check('已闭环锁定：消缺措施、要求完成日都不许再动', () => {
  assert.equal(updateMeasure(3, '换个做法').ok, false)
  assert.equal(updateDueDate(3, '2026-11-01', 班长一班).ok, false)
  assert.equal(advanceDefect(3, '提交验收').ok, false)
})

// 超期闭环 id2（要求完成日 10-03 < 今天）
check('超期闭环：闭环超期快照=true，在办超期计数同步减少', () => {
  const openBefore = defectStats().overdueOpen
  assert.equal(row(2).超期, true)
  const r = advanceDefect(2, '确认闭环')
  assert.equal(r.ok, true, r.message)
  const v = row(2)
  assert.equal(v.闭环结论, '超期闭环')
  assert.equal(v.超期标记, '闭环超期')
  assert.equal(v.abnormal, false) // 异常标记不留残留
  assert.equal(defectStats().overdueOpen, openBefore - 1)
})

check('历史已闭环老记录(id6无快照)：结论保持按时闭环，不用新算法翻旧账', () => {
  const v = row(6)
  assert.equal(v.status, '已闭环')
  assert.equal(v.闭环结论, '按时闭环')
  assert.notEqual(v['闭环超期'], true)
  assert.equal(v.实际完成时间, '')
  // 也不计入超期未闭环
  assert.equal(defectStats().overdueOpen, listDefectViews().items.filter((i) => i.status !== '已闭环' && i.超期).length)
})

check('已有时序闭环(id4按时/id5超期)快照原样保留', () => {
  assert.equal(row(4).闭环结论, '按时闭环')
  assert.equal(row(5).闭环结论, '超期闭环')
  assert.equal(ledgerPendingCount(), 2) // id5 种子台账 + id3 新增
})

// 落库失败整笔回滚
check('闭环时落库失败：状态与台账整笔退回，缓存不变', () => {
  const orig = storage.setItem.bind(storage)
  storage.setItem = () => {
    throw new Error('QuotaExceeded')
  }
  const beforeStatus = row(1).status
  const beforeLedger = listLedger().length
  const beforeActive = activeDefectCount()
  const r = advanceDefect(1, '派发消缺') // 先流转
  assert.equal(r.ok, false)
  assert.match(r.message, /整笔回滚/)
  storage.setItem = orig
  assert.equal(row(1).status, beforeStatus)
  assert.equal(listLedger().length, beforeLedger)
  assert.equal(activeDefectCount(), beforeActive)
  // localStorage 里也确实没写进去
  const persisted = JSON.parse(memory.get('pv-plant-ops:entries')!)
  assert.equal(persisted.defect.find((d: any) => d.id === 1).status, beforeStatus)
})

// 正常流转继续（回滚后数据仍可用）
check('回滚后链路可继续：id1 派发→提交→闭环', () => {
  assert.equal(advanceDefect(1, '派发消缺').ok, true)
  assert.equal(advanceDefect(1, '提交验收').ok, true)
  const r = advanceDefect(1, '确认闭环')
  assert.equal(r.ok, true)
  assert.equal(row(1).闭环结论, '超期闭环') // 要求完成日 09-30
  // id1/2/3 已闭环，剩 id7 一条在办
  assert.equal(activeDefectCount(), 1)
})

// 补录：id7 告警触发、缺发现日期 → 兜底 2026-09-01 + 3 天 = 09-04
check('要求完成日按发现方式补齐：告警触发3天，缺发现日期走兜底基准', () => {
  assert.equal(getDefectView(7)!.要求完成日, '')
  const r = backfillDueDates()
  assert.equal(r.ok, true, r.message)
  assert.equal(r.filled, 1)
  assert.equal(r.remaining, 0)
  const v = row(7)
  assert.equal(v.要求完成日, '2026-09-04')
  assert.equal(v.超期, true) // 补完后纳入超期计数
  assert.equal(defectStats().overdueOpen, 1)
})

check('补录中断后续补：再跑一遍幂等，已补的不重复', () => {
  // 没有新的缺失项时再跑补录应为 0 补齐，且 id7 的结果不被缺盖
  const again = backfillDueDates()
  assert.equal(again.ok, true)
  assert.equal(again.filled, 0)
  assert.equal(row(7).要求完成日, '2026-09-04')
})

check('补录中途失败：已补的保留，恢复后从断点接着补，全部补齐', () => {
  // 再造两条缺要求完成日的在办缺陷：例行巡视=7天、检修发现=15天
  const defectRows = allRows().defect
  commit({
    defect: [
      ...defectRows,
      { id: 101, status: '待派发', pending: true, abnormal: false, 缺陷编号: 'DEFE-2026-0101', 缺陷类别: 'x', 发现方式: '例行巡视', 严重等级: '一般', 责任班组: '光伏一班', 发现日期: '2026-09-10', 要求完成日: '', 消缺措施: 'm', 实际完成时间: '' },
      { id: 102, status: '消缺中', pending: true, abnormal: false, 缺陷编号: 'DEFE-2026-0102', 缺陷类别: 'x', 发现方式: '检修发现', 严重等级: '一般', 责任班组: '光伏二班', 发现日期: '2026-09-10', 要求完成日: '', 消缺措施: 'm', 实际完成时间: '' },
    ],
  })
  // 第一次补录：让落库总是失败，应停在第 1 条（id101），filled=0、remaining=2
  const orig = storage.setItem.bind(storage)
  storage.setItem = () => {
    throw new Error('disk full')
  }
  const failed = backfillDueDates()
  assert.equal(failed.ok, false)
  assert.equal(failed.filled, 0)
  assert.equal(failed.remaining, 2)
  assert.equal(failed.failedAt, 101)
  storage.setItem = orig
  // 恢复后再跑：两条都补上，且不影响已补过的 id7
  const recovered = backfillDueDates()
  assert.equal(recovered.ok, true)
  assert.equal(recovered.filled, 2)
  assert.equal(recovered.remaining, 0)
  assert.equal(row(101).要求完成日, '2026-09-17')
  assert.equal(row(102).要求完成日, '2026-09-25')
  assert.equal(row(7).要求完成日, '2026-09-04')
})

check('发现方式时限兜底：未知发现方式按默认7天', () => {
  commit({
    defect: [
      ...allRows().defect,
      { id: 103, status: '待派发', pending: true, abnormal: false, 缺陷编号: 'DEFE-2026-0103', 缺陷类别: 'x', 发现方式: '群众上报', 严重等级: '一般', 责任班组: '光伏一班', 发现日期: '2026-09-10', 要求完成日: '', 消缺措施: 'm', 实际完成时间: '' },
    ],
  })
  backfillDueDates()
  assert.equal(row(103).要求完成日, '2026-09-17')
})

check('另存册子与列表/详情同一口径：闭环结论、超期标记一致', () => {
  const csv = exportDefectBooklet().content
  for (const v of listDefectViews().items) {
    assert.ok(csv.includes(String(v['缺陷编号'])))
    if (v.超期标记) assert.ok(csv.includes(v.超期标记), `册子缺标记 ${v.超期标记}`)
    if (v.status === '已闭环') assert.ok(csv.includes(v.闭环结论))
  }
  // 历史 id6 在册子里也是按时闭环，而非按今天重算成超期
  const line6 = csv.split('\n').find((l) => l.includes('DEFE-2025-0088'))!
  assert.ok(line6.endsWith('按时闭环'))
})

console.log(`\n全部通过：${passed} 组`)
