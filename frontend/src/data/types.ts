/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

/** 备品备件「待领用台账」行：缺陷闭环结论回写到这里。 */
export type LedgerRow = {
  id: number
  备件编号: string
  备件名称: string
  规格型号: string
  数量: number
  缺陷编号: string
  责任班组: string
  登记时间: string
  状态: '待领用' | '已领用'
  领用时间?: string
  闭环结论: string
}

/** 要求完成日补齐进度：按缺陷 id 记账，补录中断后从断点继续。 */
export type BackfillCursor = {
  done: number[]
}

/** 当前值班身份：要求完成日只允许本责任班组的班长修改。 */
export type Operator = {
  name: string
  role: string
  crew: string
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
  /** 命中幂等保护（如连着点两次确认闭环）时为 true，数据不会重复记一笔。 */
  duplicated?: boolean
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
