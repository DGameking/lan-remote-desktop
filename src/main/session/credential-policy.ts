/**
 * 凭据回填决策（纯函数，便于单测，不触碰任何敏感数据）。
 *
 * 背景（QA P2）：用户改了用户名但把密码留空时，若仍按「!password」无条件回填
 * 已保存的密码，会把旧账号的密码注入新用户名，认证必然失败且极难排查。
 * 因此只有「本次确实是同一个账号」或「本次未指定账号」时才允许复用已存凭据。
 *
 * 规则：仅当 !inputPassword && hasSavedPassword &&
 * (!inputUsername || inputUsername === savedUsername) 时为 true。
 * 用户名比较大小写敏感（Windows 本地账户名虽不区分大小写，但为可预期起见严格比对），
 * 用户填写了与已存账号不一致的新用户名时一律返回 false，改为提示手动输入密码。
 */
export function shouldReuseSavedCredential(input: {
  inputUsername?: string
  inputPassword?: string
  savedUsername?: string
  hasSavedPassword: boolean
}): boolean {
  const { inputUsername, inputPassword, savedUsername, hasSavedPassword } = input

  // 本次已显式输入密码：以本次输入为准，绝不覆盖为已存凭据
  if (inputPassword) return false
  // 没有可用的已存密码：无从回填
  if (!hasSavedPassword) return false
  // 本次未指定用户名：视为同意复用「同一设备同一账号」的已存凭据
  if (!inputUsername) return true
  // 本次指定了用户名：仅当与已存账号完全一致时才复用
  return inputUsername === savedUsername
}
