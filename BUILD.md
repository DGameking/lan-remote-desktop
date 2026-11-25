# LanDesk 构建说明（BUILD.md）

## 1. 环境要求
- Windows 10/11 x64（主控运行与打包目标平台）
- Node.js 22（engines 已锁定 >=22）、npm 10+
- 无需 Rust / Python / Visual Studio C++ 编译链（全部依赖为纯 JS/WASM，零 native 编译）

## 2. 安装
```bash
npm install
# 国内镜像加速（可选）
npm config set registry https://registry.npmmirror.com
# Electron 二进制下载受阻时（仅编译/类型检查阶段）
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```
说明：`sql.js` 为 SQLite 的 WASM 实现，安装时无需编译；`bonjour-service`、`vue`、`element-plus` 均为纯 JS。

## 3. 常用命令
| 命令 | 用途 |
|------|------|
| `npm run dev` | 开发模式（electron-vite 热更新） |
| `npm run typecheck` | Node + Web 两侧 tsc 类型检查 |
| `npm run typecheck:vue` | Vue SFC 模板类型检查（vue-tsc） |
| `npm run test:unit` | vitest 纯函数单元测试 |
| `npm run build` | 三进程构建到 `out/`（main / preload / renderer） |
| `npm run dist` | 构建 + electron-builder 打包到 `dist/`（NSIS + portable，x64） |

打包产物：`dist/LanDesk-1.10.0-setup-x64.exe`、`dist/LanDesk-1.10.0-portable-win-x64.exe`（随版本号更新）。
CI 中调用 `npm run dist -- --x64` 显式指定架构；本地打包请保持 windows x64。

## 4. CI / Release
- 工作流：`.github/workflows/build.yml`，`on: push tags 'v*'` 或手动 `workflow_dispatch`。
- 质量硬卡点（四项，全部必须通过）：`typecheck` + `typecheck:vue` + `test:unit` + `dist` 构建。**lint 非卡点**（MVP 不加 eslint 配置，typecheck 已覆盖类型安全）。
- 发布：tag `v1.5.0` 触发 `windows-latest` 构建，`softprops/action-gh-release` 上传两个 exe 与 `SHA256SUMS.txt`。
- 校验值：CI 用 PowerShell `Get-FileHash -Algorithm SHA256` 生成 `dist/SHA256SUMS.txt`。

## 5. 存储与降级
- 默认：`sql.js`（SQLite WASM）数据库落 `app.getPath('userData')`。
- 降级：若打包后 WASM 定位失败，自动切换到 JSON 文件持久化（`userData` 下），功能不变、查询走文件。
- 凭据：Electron `safeStorage`（Windows DPAPI）加密后 base64 落盘，绝不明文；密码不写入 `.rdp`、不进入任何进程命令行。

## 6. 已知限制
- 主控仅 Windows x64；被控端服务需设备所有者预先开启。
- 平台自动识别受 VNC 协议限制（5900 无法区分 mac/Linux/fnOS），支持手动纠正。
- 首版零遥测，无崩溃自动上报；本地日志脱敏后留存 30 天。
- 未签名 exe 触发 SmartScreen，详见 README 第七节。
- RustDesk 为可选外部调起，依赖本机已安装官方客户端。
- 共享剪贴板/磁盘重定向请在可信设备间开启；标准 VNC 无文件传输（用 SMB 通道）；SMB 传文件需对端开启共享并授权；跨设备常驻剪贴板同步不在范围。

## 7. 验证状态（2026-11-25 v1.10.0 全量通过）
- `npm run typecheck` ✓（主进程）
- `npm run typecheck:vue` ✓（渲染层）
- `npm run test:unit` ✓ **484/484（36 个测试文件）**；v1.3 基线 169 → v1.4 218 → v1.5 首轮 301 → 发布前修复 321 → v1.5.1 IPC 净化 330 → v1.6 设备管理 350 → v1.7 在线感知+直连 397 → v1.7.1 连接与凭据修复 421 → v1.8 显示模式 440 → v1.9 会话码 467 → v1.10 诚实性与数据完整性 484
- `npm run build` ✓（main / preload / renderer 三进程）
- `npm run dist -- --x64 --publish never` ✓（electron 45.4.1）
- 独立审校：v1.4 全面审校发现 5 项 P0，v1.5 全部清零；v1.7.1 本机实测三处 P0 见 `docs/19`，v1.8 显示模式重做见 `docs/20`，v1.9 会话码方案 2b 见 `docs/21`，**v1.10 三路全面审校（会话协议/UI/数据链）发现 1 处状态语义缺陷 + 5 项 P0 数据丢失/安全面，全部修复并回归，见 `docs/22`**。
- 产物：`dist/LanDesk-1.10.0-setup-x64.exe`、`dist/LanDesk-1.10.0-portable-win-x64.exe`、`dist/SHA256SUMS.txt`。
- v1.10 修复：会话状态诚实化（客户端退出=failed+可读原因，仅主动结束=ended）、扫描/添加/导入不再清空用户元数据、备份注入路径 RCE 拦截、扫描停止不留假离线、防竞态；UI 现代化（语义状态色/错误信息可读/列宽重排/设计 token）；新增 `tests/v110-session-honesty.test.ts`（7 例）、`tests/v110-data-integrity.test.ts`（10 例）。
