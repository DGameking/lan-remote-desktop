import type { IpcResponse } from '../../shared/types'

/** window.electronAPI 由 preload 通过 contextBridge 注入，是渲染层唯一的主进程入口 */
export const api = window.electronAPI

/** 统一解包 {code, message, data}，非 0 直接抛错 */
export async function unwrap<T>(promise: Promise<IpcResponse<T>>): Promise<T> {
  const response = await promise
  if (response.code !== 0) throw new Error(response.message || '操作失败')
  return response.data as T
}
