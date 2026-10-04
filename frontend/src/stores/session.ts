import { defineStore } from 'pinia'
import type { Operator } from '@/data/types'

// 演示用值班身份：要求完成日只允许“本责任班组的班长”修改，可在这里切换验证权限。
export const OPERATOR_PRESETS: Operator[] = [
  { name: '张建国', role: '班长', crew: '组件一班' },
  { name: '李海燕', role: '班长', crew: '电气二班' },
  { name: '王大力', role: '班员', crew: '组件一班' },
]

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: OPERATOR_PRESETS[0].name,
    role: OPERATOR_PRESETS[0].role,
    crew: OPERATOR_PRESETS[0].crew,
    shiftLabel: '白班 08:00-20:00',
    scope: '光伏电站运行维护管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    operatorInfo(state): Operator {
      return { name: state.operator, role: state.role, crew: state.crew }
    },
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setOperator(operator: Operator) {
      this.operator = operator.name
      this.role = operator.role
      this.crew = operator.crew
    },
  },
})
