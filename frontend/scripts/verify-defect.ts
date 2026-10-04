import assert from 'node:assert'
import {
  activeDefectCount,
  backfillDeadlineStep,
  backfillRemaining,
  canEditDeadline,
  closeDefect,
  deadlineFor,
  defectDetail,
  defectStats,
  deriveDefect,
  dispatchDefect,
  exportDefectsCsv,
  ledgerForDefect,
  listDefects,
  listPendingLedger,
  receiveLedger,
  submitDefect,
  updateDeadline,
  updateMeasure,
  updateRequiredSpare,
} from '../src/api/defect-service'
import { storageKey } from '../src/data/local-store'

type Store = Record<string, string>
function makeLocalStorage() {
  const store: Store = {}
  let failOnSet = false
  return {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      if (failOnSet) {
        throw new Error('模拟配额写满')
      }
      store[key] = value
    },
    removeItem: (key: string) => {
      delete store[key]
    },
    armFailure: () => {
      failOnSet = true
    },
    dump: () => store,
  }
}

import type { Operator } from '../src/data/types'

const zhang: Operator = { name: '张建国', role: '班长', crew: '组件一班' }
const li: Operator = { name: '李海燕', role: '班长', crew: '电气二班' }
const wang: Operator = { name: '王大力', role: '班员', crew: '组件一班' }

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

// 固定“今天”：种子数据围绕 2026-10-04 构造
const REF = '2026-10-04'

function resetEnv() {
  const ls = makeLocalStorage()
  ;(globalThis as { window?: unknown }).window = { localStorage: ls }
  // 重置模块缓存：通过删 localStorage key 强制重新播种
  ls.removeItem(storageKey())
  return ls
}

console.log('1) 顺流状态机 + 回退/跳环拒绝')
resetEnv()
const id1 = listDefects().find((r) => r['缺陷编号'] === 'DEFE-0001')!.id as number
check('待派发不能直接确认闭环', () => {
  assert.equal(closeDefect(id1, zhang).ok, false)
})
check('待派发不能提交验收（跳环）', () => {
  assert.equal(submitDefect(id1).ok, false)
})
check('派发消缺：待派发→消缺中', () => {
  assert.equal(dispatchDefect(id1).ok, true)
  assert.equal(defectDetail(id1)!.row.status, '消缺中')
})
check('消缺中不能再派发（回不去上一环）', () => {
  assert.equal(dispatchDefect(id1).ok, false)
})

console.log('2) 提交验收前必须有消缺措施')
check('措施为空时提交验收被拒', () => {
  assert.equal(submitDefect(id1).ok, false)
})
check('保存措施后可提交验收', () => {
  assert.equal(updateMeasure(id1, '更换破损组件', zhang).ok, true)
  assert.equal(submitDefect(id1).ok, true)
  assert.equal(defectDetail(id1)!.row.status, '待验收')
})

console.log('3) 超期口径统一 + 闭环后计数/标记联动 + 台账回写 + 幂等')
// DEFE-0003：要求完成日 2026-10-10，未超期
const id3 = listDefects().find((r) => r['缺陷编号'] === 'DEFE-0003')!.id as number
check('未到要求完成日不算超期', () => {
  assert.equal(deriveDefect(defectDetail(id3)!.row, REF).overdue, false)
})
check('闭环需用备件先登记，闭环后回写台账', () => {
  assert.equal(updateRequiredSpare(id3, 'SPAR-0001 ×2', zhang).ok, true)
  const res = closeDefect(id3, zhang, REF)
  assert.equal(res.ok, true, res.message)
  assert.equal(defectDetail(id3)!.row.status, '已闭环')
  assert.equal(defectDetail(id3)!.row.abnormal, false)
  const ledger = ledgerForDefect('DEFE-0003')
  assert.ok(ledger, '台账应有回写记录')
  assert.equal(ledger!.备件编号, 'SPAR-0001')
  assert.equal(ledger!.数量, 2)
  assert.equal(ledger!.状态, '待领用')
  assert.ok(ledger!.闭环结论.includes('按期闭环'))
})
check('连着再点确认闭环只算一次（幂等，台账不重复）', () => {
  const res = closeDefect(id3, zhang, REF)
  assert.equal(res.ok, true)
  assert.equal(res.duplicated, true)
  const count = listPendingLedger().filter((l) => l.缺陷编号 === 'DEFE-0003').length
  assert.equal(count, 1)
})
check('闭环后消缺措施/要求完成日冻结', () => {
  assert.equal(updateMeasure(id3, '再改改', zhang).ok, false)
  assert.equal(updateDeadline(id3, '2026-11-01', zhang).ok, false)
})
check('台账办理领用幂等', () => {
  const ledger = ledgerForDefect('DEFE-0003')!
  assert.equal(receiveLedger(ledger.id).ok, true)
  const again = receiveLedger(ledger.id)
  assert.equal(again.ok, true)
  assert.equal(again.duplicated, true)
})
let id4 = 0
check('超期闭环：DEFE-0004（要求 09-20，完成 10-04）按超期冻结，台账不登记（无备件）', () => {
  id4 = listDefects().find((r) => r['缺陷编号'] === 'DEFE-0004')!.id as number
  const res = closeDefect(id4, li, REF)
  assert.equal(res.ok, true, res.message)
  const detail = defectDetail(id4)!
  assert.equal(detail.overdue, true)
  assert.equal(detail.overdueDays, 14)
  assert.ok(detail.row.闭环结论.includes('超期14天闭环'))
  assert.ok(!ledgerForDefect('DEFE-0004'))
})
check('闭环后超期计数不再算它，但历史“超期闭环”结论保留', () => {
  const stats = defectStats({}, REF)
  // 超期未闭环：DEFE-0002 一条（09-25 已过且仍在办）；DEFE-0004 已闭环不计入
  assert.equal(stats.overdueOpen, 1)
  assert.ok(defectDetail(id4)!.overdueText.includes('超期14天闭环'))
})

console.log('4) 在办缺陷数：缺陷页与备品页同口径')
check('在办数 = 未闭环条数（种子7条；本流程已闭环 DEFE-0003/0004，历史闭环 0005/0006）', () => {
  // 7 条种子 - 历史闭环2条 - 本流程闭环2条 = 3 条在办
  assert.equal(activeDefectCount(), 3)
})

console.log('5) 权限：只有本责任班组班长能改要求完成日')
const id2 = listDefects().find((r) => r['缺陷编号'] === 'DEFE-0002')!.id as number // 电气二班
check('班员不能改', () => assert.equal(updateDeadline(id2, '2026-10-10', wang).ok, false))
check('别的班组班长不能改', () => assert.equal(updateDeadline(id2, '2026-10-10', zhang).ok, false))
check('本班组班长可改，改后超期标记联动重算', () => {
  assert.equal(updateDeadline(id2, '2026-12-31', li).ok, true)
  assert.equal(defectDetail(id2)!.overdue, false)
  assert.equal(defectDetail(id2)!.row.abnormal, false)
})
check('canEditDeadline 口径一致', () => {
  const row = defectDetail(id2)!.row
  assert.equal(canEditDeadline(li, row), true)
  assert.equal(canEditDeadline(wang, row), false)
})

console.log('6) 补录：按发现方式补齐，中断后从断点继续')
// DEFE-0007 例行试验、发现 2026-10-01、缺要求完成日 → 应为 10-01 + 7 = 10-08
const id7 = listDefects().find((r) => r['缺陷编号'] === 'DEFE-0007')!.id as number
check('补录前剩余 1 条', () => assert.equal(backfillRemaining(), 1))
check('deadlineFor：告警1天/测温3天/检修5天/试验7天/巡视10天', () => {
  assert.equal(deadlineFor('告警转缺陷', '2026-10-01', REF), '2026-10-02')
  assert.equal(deadlineFor('红外测温', '2026-10-01', REF), '2026-10-04')
  assert.equal(deadlineFor('日常巡视', '2026-10-01', REF), '2026-10-11')
})
const step = backfillDeadlineStep()
check('补录一笔成功且日期正确', () => {
  assert.equal(step.ok, true, step.message)
  assert.equal(step.filled, 'DEFE-0007')
  assert.equal(defectDetail(id7)!.row['要求完成日'], '2026-10-08')
  assert.equal(step.remaining, 0)
})
check('补录完成后剩余 0，再点不报错', () => {
  assert.equal(backfillRemaining(), 0)
  assert.equal(backfillDeadlineStep().ok, true)
})

console.log('7) 要求完成日/完成时间校验')
check('完成时间不能早于发现日期', () => {
  assert.equal(closeDefect(id1, zhang, '2026-09-01').ok, false)
})
check('要求完成日不能早于发现日期', () => {
  const id = listDefects().find((r) => r['缺陷编号'] === 'DEFE-0001')
  // DEFE-0001 组件一班，班长张建国可改
  assert.equal(updateDeadline(id!.id as number, '2026-09-01', zhang).ok, false)
})

console.log('8) 落库失败整笔回滚：状态、台账、计数都不变')
const ls2 = resetEnv()
// 取一条未闭环记录推进到“待验收 + 已登记备件”（DEFE-0002 消缺中、电气二班）
const rollbackTarget = listDefects().find((r) => r['缺陷编号'] === 'DEFE-0002')!.id as number
assert.equal(submitDefect(rollbackTarget).ok, true)
assert.equal(updateRequiredSpare(rollbackTarget, 'SPAR-0002 ×1', li).ok, true)
// 武装写库失败，再确认闭环：状态、台账、超期标记必须整笔退回
ls2.armFailure()
const failed = closeDefect(rollbackTarget, li, REF)
check('写库失败时闭环返回失败且整笔回滚', () => {
  assert.equal(failed.ok, false)
  assert.ok(failed.message.includes('回滚'))
  // 内存缓存已回滚：DEFE-0002 仍为待验收、台账未新增
  assert.equal(defectDetail(rollbackTarget)!.row.status, '待验收')
  assert.ok(!ledgerForDefect('DEFE-0002'))
  assert.equal(listPendingLedger().filter((l) => l.缺陷编号 === 'DEFE-0002').length, 0)
})
check('落库里也没有半截数据（仍是待验收旧值）', () => {
  // 失败时不写 storage；读到的是武装失败前最后一次成功提交的快照
  const persisted = JSON.parse(ls2.getItem(storageKey())!) as { defect: { id: number; status: string }[] }
  const row = persisted.defect.find((r) => r.id === rollbackTarget)!
  assert.equal(row.status, '待验收')
})

console.log('9) 历史已闭环结论原样保留（DEFE-0005 超期闭环、DEFE-0006 按期）')
resetEnv()
check('历史闭环结论与台账不被重算改写', () => {
  const id5 = listDefects().find((r) => r['缺陷编号'] === 'DEFE-0005')!.id as number
  const id6 = listDefects().find((r) => r['缺陷编号'] === 'DEFE-0006')!.id as number
  assert.equal(defectDetail(id5)!.overdue, true)
  assert.ok(defectDetail(id5)!.row.闭环结论.includes('超期3天'))
  assert.equal(defectDetail(id6)!.overdue, false)
  const ledger = ledgerForDefect('DEFE-0005')
  assert.ok(ledger)
  assert.equal(ledger!.状态, '待领用')
})

console.log('10) 导出册子与详情同一口径')
check('CSV 中闭环记录带超期结论列', () => {
  const { content } = exportDefectsCsv()
  assert.ok(content.includes('超期3天闭环'))
  assert.ok(content.includes('按期闭环'))
  assert.ok(content.includes('超期结论'))
})

console.log(`\n全部 ${passed} 项检查通过 ✅`)
