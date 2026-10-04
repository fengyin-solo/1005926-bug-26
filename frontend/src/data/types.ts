/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
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
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 当前登录人：改要求完成日时要核「班长 + 本责任班组」。 */
export type OperatorRole = '班长' | '班员' | '值班管理员'

export type Operator = {
  name: string
  role: OperatorRole
  crew: string
}

/** 闭环时领用的备件（确认闭环弹窗里填，不填就是不涉及备件）。 */
export type SpareUsage = {
  备件编号: string
  备件名称: string
  数量: number
}

/** 备品备件待领用台账行：由消缺闭环结论回写。 */
export type SpareLedgerRow = EntryRow & {
  defectId: number
  缺陷编号: string
  备件编号: string
  备件名称: string
  数量: number
  责任班组: string
  登记时间: string
  状态: '待领用' | '已领用'
}

/** 补录要求完成日的结果：按缺陷编号逐条提交，中断后再跑会从没补上的继续。 */
export type BackfillResult = {
  ok: boolean
  filled: number
  remaining: number
  message: string
  failedAt?: number
}
