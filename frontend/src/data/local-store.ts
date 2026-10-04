import { SEED_ROWS } from './seed'
import type { BackfillCursor, EntryRow, LedgerRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'pv-plant-ops:entries'
// 跨模块台账与补录进度也存在同一份存储里，缺陷与台账可以同笔提交、同笔回滚。
const LEDGER_KEY = 'spareLedger'
const BACKFILL_KEY = 'defectDeadlineBackfill'

/** 一份持久化 blob：各模块记录 + 待领用台账 + 补录进度。 */
export type DataBlob = {
  [key: string]: EntryRow[] | LedgerRow[] | BackfillCursor | undefined
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedBlob(): DataBlob {
  const ledger = SEED_ROWS[LEDGER_KEY as keyof typeof SEED_ROWS] as unknown as LedgerRow[]
  const backfill: BackfillCursor = { done: [] }
  return { ...(clone(SEED_ROWS) as unknown as DataBlob), [LEDGER_KEY]: clone(ledger), [BACKFILL_KEY]: backfill }
}

function readStorage(): DataBlob {
  const fallback = seedBlob()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DataBlob>
    // 老存档没有台账/补录位：用种子补齐，历史缺陷记录原样保留。
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: DataBlob | null = null

export function allRows(): DataBlob {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  const rows = allRows()[key]
  return (rows as EntryRow[] | undefined) ?? []
}

export function listLedger(): LedgerRow[] {
  const rows = allRows()[LEDGER_KEY]
  return (rows as LedgerRow[] | undefined) ?? []
}

export function backfillCursor(): BackfillCursor {
  const cursor = allRows()[BACKFILL_KEY]
  return (cursor as BackfillCursor | undefined) ?? { done: [] }
}

/**
 * 在整份 blob 的深拷贝上改：改完先序列化自检（相当于提交前校验），
 * 再一次性落库；任一步失败都不替换内存缓存，等同于整笔事务回滚。
 */
export function commitBlob(mutate: (blob: DataBlob) => void): void {
  const snapshot = allRows()
  const draft = clone(snapshot)
  mutate(draft)
  // 提交前自检：循环引用等结构问题在写库前就暴露，脏数据不会碰到缓存。
  const serialized = JSON.stringify(draft)
  cache = draft
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, serialized)
    }
  } catch (error) {
    // 落库失败：内存缓存恢复到提交前，页面与存储都保持原状（整笔退回）。
    cache = snapshot
    throw error instanceof Error ? error : new Error('数据落库失败，已整笔回滚')
  }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitBlob((blob) => {
    blob[key] = rows
  })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone((SEED_ROWS[key] as EntryRow[] | undefined) ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
