/**
 * IPC 参数净化：把 Vue 响应式对象（Proxy）、数组、普通对象递归转成"结构化可克隆"的纯数据。
 *
 * 背景：Electron 的 ipcRenderer.invoke 使用 HTML 结构化克隆算法传参，无法克隆 Proxy。
 * 渲染层若把 ref/reactive 持有的对象（如 precheck.value）直接塞进 IPC 参数，
 * 会抛出 `DataCloneError: An object could not be cloned.`——表现为连接对话框弹出红色错误条。
 *
 * 本函数放在 preload 边界对所有对象参数统一调用，作为纵深防御：
 * 即使渲染层误传了响应式对象，也不会让 IPC 崩溃。
 *
 * - 基本类型（string/number/boolean/null/undefined/bigint/symbol 除外的原始值）原样返回
 * - Date / RegExp / Map / Set / ArrayBuffer / TypedArray 等可克隆对象保持原样
 * - 数组、普通对象（含 Proxy）递归展开为纯数组/纯对象
 * - 函数、Symbol 等不可克隆值：剔除对应键（对象）或转为 undefined（数组位），绝不抛错
 */
export function toPlain<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value

  const obj = value as unknown as object
  if (seen.has(obj)) return seen.get(obj) as T

  if (Array.isArray(value)) {
    const out: unknown[] = []
    seen.set(obj, out)
    for (const item of value) out.push(toPlain(item, seen))
    return out as T
  }

  // 这些是结构化克隆原生支持的类型，原样透传即可
  if (
    obj instanceof Date ||
    obj instanceof RegExp ||
    obj instanceof Map ||
    obj instanceof Set ||
    obj instanceof ArrayBuffer ||
    ArrayBuffer.isView(obj)
  ) {
    return value
  }

  const out: Record<string, unknown> = {}
  seen.set(obj, out)
  for (const key of Object.keys(obj)) {
    const val = (obj as Record<string, unknown>)[key]
    const type = typeof val
    if (type === 'function' || type === 'symbol') continue
    out[key] = toPlain(val, seen)
  }
  return out as T
}
