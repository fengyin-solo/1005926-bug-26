import { defineStore } from 'pinia'

import type { Operator } from '@/data/types'

// 演示用身份：缺陷页可切换，便于验证「只有本责任班组的班长能改要求完成日」。
export const PRESET_OPERATORS: Operator[] = [
  { name: '张班长', role: '班长', crew: '光伏一班' },
  { name: '李班长', role: '班长', crew: '光伏二班' },
  { name: '王小虎', role: '班员', crew: '光伏一班' },
  { name: '值班管理员', role: '值班管理员', crew: '' },
]

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: { name: '值班管理员', role: '值班管理员', crew: '' } as Operator,
    shiftLabel: '白班 08:00-20:00',
    scope: '光伏电站运行维护管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.name.length > 0,
    // 只有本责任班组的班长可以改要求完成日：岗位是班长、且班组与缺陷责任班组一致。
    canEditDueDate: (state) => (crew: string) =>
      state.operator.role === '班长' && crew.length > 0 && state.operator.crew === crew,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setOperator(operator: Operator) {
      this.operator = operator
    },
  },
})
