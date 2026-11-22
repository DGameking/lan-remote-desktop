import { describe, it, expect } from 'vitest'
import { reactive, ref } from 'vue'
import { toPlain } from '../src/shared/ipc-sanitize'

describe('toPlain - IPC 参数净化（修复 An object could not be cloned）', () => {
  it('普通对象递归展开为纯对象', () => {
    const input = { a: 1, b: { c: 2, d: [3, 4] } }
    const out = toPlain(input)
    expect(out).toEqual(input)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
  })

  it('Vue reactive Proxy 展开为可结构化克隆的纯对象', () => {
    const proxy = reactive({
      ip: '192.168.10.15',
      port: 5900,
      reachable: true,
      latencyMs: 12,
      actions: ['确认已开启屏幕共享']
    })
    const out = toPlain(proxy)
    expect(out).toEqual({
      ip: '192.168.10.15',
      port: 5900,
      reachable: true,
      latencyMs: 12,
      actions: ['确认已开启屏幕共享']
    })
    // 关键断言：输出不是 Proxy，可被 structuredClone 克隆
    expect(() => structuredClone(out)).not.toThrow()
  })

  it('ref.value 内的响应式对象同样被净化', () => {
    const wrapped = ref({ conclusion: 'firewall_or_auth', actions: ['检查防火墙'] })
    const out = toPlain(wrapped.value)
    expect(() => structuredClone(out)).not.toThrow()
    expect(out.conclusion).toBe('firewall_or_auth')
  })

  it('原始 Proxy 直接 structuredClone 会失败（证明修复必要性）', () => {
    const proxy = reactive({ a: 1 })
    expect(() => structuredClone(proxy)).toThrow()
  })

  it('函数与 Symbol 字段被剔除，不抛错', () => {
    const input = { keep: 1, fn: () => 2, sym: Symbol('x'), nested: { drop: () => {} } }
    const out = toPlain(input) as Record<string, unknown>
    expect(out.keep).toBe(1)
    expect('fn' in out).toBe(false)
    expect('sym' in out).toBe(false)
    expect(out.nested).toEqual({})
  })

  it('循环引用被去重，不会栈溢出', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    const out = toPlain(a) as { name: string; self: unknown }
    expect(out.name).toBe('a')
    expect(out.self).toBe(out)
  })

  it('Date 等可克隆原生类型原样透传', () => {
    const date = new Date('2026-11-22T12:00:00Z')
    expect(toPlain(date)).toBe(date)
  })

  it('undefined / null / 基本类型原样返回', () => {
    expect(toPlain(undefined)).toBeUndefined()
    expect(toPlain(null)).toBeNull()
    expect(toPlain(42)).toBe(42)
    expect(toPlain('x')).toBe('x')
    expect(toPlain(true)).toBe(true)
  })

  it('数组中的 Proxy 元素逐个净化', () => {
    const items = reactive([{ id: 1 }, { id: 2 }])
    const out = toPlain(items)
    expect(out).toEqual([{ id: 1 }, { id: 2 }])
    expect(() => structuredClone(out)).not.toThrow()
  })
})
