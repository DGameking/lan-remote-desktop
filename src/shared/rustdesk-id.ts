/**
 * v1.9（方案 2b）：RustDesk 会话码 / 设备 ID 校验（纯函数，无 Node / DOM 依赖）。
 *
 * 安全边界：本模块只做白名单校验与规范化，不发起连接、不拼装 shell 命令、
 * 不解析 URL。会话码仅作为"外部官方客户端的连接目标标识"传入 adapter。
 *
 * 会话码格式：RustDesk 官方生成的 ID 通常是 9-10 位数字，也支持自定义
 * 字母数字 ID。这里采用保守白名单——字母、数字、下划线、连字符，1-64 位；
 * 拒绝空格、点、冒号、斜杠、查询串与一切 URL / shell 元字符。
 */
const RUSTDESK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * 规范化并校验会话码。合法返回 trim 后的字符串，非法返回 undefined（不抛异常）。
 */
export function normalizeRustdeskId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return RUSTDESK_ID_RE.test(trimmed) ? trimmed : undefined
}

/** 是否为合法会话码（布尔版，供校验器与 UI 使用） */
export function isRustdeskId(value: unknown): boolean {
  return normalizeRustdeskId(value) !== undefined
}
