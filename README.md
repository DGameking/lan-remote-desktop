# LanDesk

> 一台 Windows 电脑，集中掌控局域网内所有异构设备。

LanDesk 是一款运行在本机 Windows 上的**局域网远程桌面主控端**：聚合 RDP / VNC / RustDesk 三种协议，集中发现并连接 Windows、macOS、Linux、飞牛OS(fnOS) 桌面。

**纯局域网 · 无服务端 · 无公网中转 · 无账号 · 不上传任何设备信息。**

---

## 一、合规红线（使用前必读）

1. **仅可连接你自己拥有、或已获得设备所有者明确书面授权的设备。**
2. 禁止用于未经授权的访问、扫描、控制或任何违反法律、单位规章的行为。
3. 使用者对自身行为承担全部责任；本项目作者不对任何滥用行为负责。
4. 首次启动会弹出合规声明，必须勾选确认后才能进入主界面；每次连接还需再次确认。

---

## 二、它能做什么

- 自动扫描本机所在 /24 网段的 3389 / 5900 / 21116 端口（并发 50、单连接超时 400ms）。
- mDNS（`_rfb._tcp` / `_rdp._tcp`）补充设备名，只读 `arp -a` 补充在线候选 IP。
- 按 IP 聚合去重，自动推断平台（3389→Windows，5900→macOS/Linux 待定，名称关键字补充飞牛OS 等）。
- 卡片 / 表格双视图，展示在线状态、可用协议标签与来源。
- 外部客户端调起：RDP→系统 `mstsc.exe`，VNC→本机 TigerVNC/RealVNC/TightVNC Viewer，RustDesk→官方客户端（可选）。
- 手动添加 IP（多网卡 / AP 隔离导致发现失败时的必备兜底路径）。
- 凭据经 Windows DPAPI（`safeStorage`）加密后以密文落盘，界面永不显示明文。
- 连接历史本地留存；日志仅保留最近 30 天；**当前版本零遥测——不采集、不上传任何诊断数据，也不含遥测开关**。
- **共享剪贴板**：RDP 会话内剪贴板重定向（可开关）；VNC/RustDesk 由外部客户端原生提供。
- **文件传输**：RDP 会话内磁盘重定向（可开关），或用 Windows 资源管理器直接打开对端 SMB 共享（全平台）。
- **连接优化**：发起前 TCP 端口预检与延迟显示，RDP 局域网参数调优，连接结果回显本次启用的能力。

明确**不做**：公网中转/打洞、自研被控端、自研协议栈、移动/iOS/鸿蒙主控、账号云同步、会话录像。剪贴板与文件传输均复用系统/客户端原生能力，LanDesk 不自研传输协议、不缓存其内容。

---

## 三、技术栈

| 层 | 选型 |
|----|------|
| 桌面框架 | Electron 33 + electron-vite |
| UI | Vue 3 + Element Plus + TypeScript |
| 存储 | sql.js（SQLite WASM，落 userData）+ 失败降级 JSON |
| 凭据 | Electron `safeStorage`（Windows DPAPI）加密后 base64 落盘 |
| 发现 | Node net 并发端口探测 + bonjour-service(mDNS) + 只读 arp -a |
| 打包 | electron-builder（Windows NSIS + portable，x64，asar） |

---

## 四、快速开始

环境要求：Windows 10/11 x64、**Node.js 22**、npm 10+。

```bash
npm install
npm run dev        # 开发模式（热更新）
npm run typecheck  # 类型检查
npm run build      # 构建到 out/
npm run dist       # 构建 + 打包 NSIS / portable 到 dist/
```

> 若 npm 下载缓慢，可先执行 `npm config set registry https://registry.npmmirror.com`。
> 若 Electron 二进制下载受阻，可设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
> 或在仅做类型检查/构建时设置 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`。

开发模式下 sql.js 的 WASM 从 `node_modules/sql.js/dist` 定位；打包后若定位失败会自动降级到 JSON 文件持久化（见 BUILD.md）。

---

## 五、被控端开启指引

### Windows（RDP，3389）
1. 设置 → 系统 → 远程桌面 → 启用“启用远程桌面”。
2. 确认本机为 Windows 10/11 **专业版/企业版**（家庭版无传入 RDP 服务端）。
3. 防火墙放行“远程桌面”规则；记录被控机 IP。
4. 被控账号需有密码，且属于 Remote Desktop Users 组。

### macOS（VNC，5900）
1. 系统设置 → 通用 → 共享 → 打开“屏幕共享”。
2. 点击右侧 `i`，设置允许访问的账户与 VNC 密码（至少 8 位）。
3. 防火墙允许屏幕共享；记录 Mac 的 IP。

### Linux（VNC，5900+）
- X11 环境：安装 `x11vnc` 或 `tigervnc-server`，例如 `x11vnc -forever -passwd 你的密码 -rfbport 5900`。
- Wayland 环境：优先使用发行版自带的 VNC 方案（如 GNOME 的“远程桌面”/`gnome-remote-desktop`），或改用 TigerVNC 的 Xorg 会话。
- 防火墙放行 5900；记录 Linux 主机 IP。

### 飞牛OS（fnOS，5900 / RustDesk）
1. 飞牛OS 桌面 → 设置 → 远程访问/桌面 → 开启内置 VNC（默认 5900），设置访问密码。
2. 或在应用中心安装 RustDesk 官方客户端，记录其设备 ID 与临时密码。
3. 防火墙放行对应端口。

> 各被控端服务必须**预先由设备所有者开启**。若扫描显示端口未开放，请先在对应设备上完成上述配置，或在 LanDesk“设置 → 手动添加设备”中直接添加 IP。

---

## 五·补、共享剪贴板与文件传输（v1.1.0 新增）

所有共享能力都基于各系统/客户端**原生功能**，LanDesk 只负责调起与开关配置，不实现协议、不经手文件内容。

### 能力矩阵

| 连接通道 | 共享剪贴板 | 文件传输 | 由谁提供 |
|---|---|---|---|
| **RDP**（Windows↔Windows） | ✅ 会话内重定向 | ✅ 会话内磁盘重定向（拖拽复制） | Windows RDP 原生 |
| **SMB 文件通道**（全平台，点“传文件”） | — | ✅ 资源管理器打开 `\\IP\共享名` | Windows 资源管理器 + 对端 SMB |
| **RustDesk**（可选） | ✅ 会话内同步 | ✅ 客户端内“文件传输” | RustDesk 官方客户端 |
| **VNC**（macOS/Linux/飞牛OS） | ✅ 取决于 Viewer | ❌ 标准 VNC 无文件传输 | 外部 VNC Viewer |

### 使用方式

- **剪贴板**：连接对话框里“共享剪贴板”开关控制（RDP 默认开）。连接后即可在两台电脑间复制文本/图片。
- **RDP 会话内传文件**：开启“文件传输（磁盘重定向）”后，远程桌面里会看到本机磁盘，直接拖拽即可复制。注意：被控端可访问你映射的磁盘，**仅对可信设备开启**；用完可在连接对话框关掉。
- **跨系统传文件（推荐给 macOS/Linux/飞牛OS）**：在设备卡片点“传文件”，填入对端共享名，LanDesk 用资源管理器打开 `\\IP\共享名`，像本地文件夹一样读写。对端需先开启 SMB 文件共享：
  - Windows：启用网络发现与文件共享，设置共享文件夹；
  - 飞牛OS：控制面板开启 SMB/文件服务，用共享文件夹；
  - macOS：系统设置 → 通用 → 共享 → 文件共享（SMB）；
  - Linux：运行 Samba 并配置共享目录。
  - 常用共享名可在“设置 → 共享能力”里保存，之后自动填入。
- **连接优化**：连接前会先做 TCP 端口预检并显示往返延迟；端口未开时直接给出提示，避免盲目调起客户端。RDP 使用局域网带宽自动检测与连接类型优化。

> 隐私说明：LanDesk 不读取、不缓存、不上传剪贴板内容与传输的文件；这些能力完全由会话/系统承载。

---

## 六、协议与开源许可边界

- **RDP**：调起 Windows 系统自带 `mstsc.exe`。
- **VNC**：调起你自己安装的 VNC Viewer（TigerVNC / x11vnc 为 GPL，RealVNC 等各有许可）。LanDesk **不随包分发、不内嵌、不修改**这些程序。
- **RustDesk（AGPL-3.0）**：仅通过命令行 `rustdesk.exe --connect <id>` 或 `rustdesk://` 链接调起**独立安装的官方客户端**。进程间调用不构成衍生作品；本项目**禁止内嵌、捆绑、修改或重新分发 RustDesk 代码**，否则会产生 AGPL 传染义务。
- 本项目自研代码采用 **MIT 许可证**。

---

## 七、未签名 exe / SmartScreen 说明

本项目 CI 产出的 exe **未做代码签名**（代码签名证书需另行申请）。首次运行 Windows SmartScreen 可能提示“Windows 已保护你的电脑”：

1. 在“更多信息”中选择“仍要运行”。
2. 这是未签名应用的正常提示，不代表一定有病毒；但请务必从可信来源（本项目 GitHub Releases）下载。

**校验完整性**：每个 Release 会在 `SHA256SUMS.txt` 中给出安装包 SHA256。下载后在 PowerShell 中执行：

```powershell
Get-FileHash .\LanDesk-1.1.0-setup-x64.exe -Algorithm SHA256
```

将输出哈希与 `SHA256SUMS.txt` 中的记录逐位比对；不一致请勿运行。

---

## 八、已知限制

- 主控端仅支持 Windows（RDP 依赖系统 mstsc，文件传输依赖资源管理器/SMB）。
- RustDesk 为 P2 可选能力，依赖本机已安装官方客户端。
- 扫描以本机所在 /24 为主；多网卡 / AP 隔离环境请手动添加 IP。
- 打包后 WASM 若定位失败会降级 JSON 存储，功能不变但查询走 JSON 文件。
- VNC 为明文协议，仅限可信局域网使用，且标准 VNC 不含文件传输（请用 SMB 通道或 RDP）。
- SMB 传文件需对端预先开启文件共享并给出授权账号；剪贴板/磁盘重定向请仅在可信设备间开启。
- 跨设备的“常驻剪贴板同步”（断开会话后仍同步）需要中心服务，与本项目“无服务端”定位冲突，不在范围内。

## 九、隐私与数据边界

LanDesk 的设备发现、连接与凭据存储全部在本机/局域网内完成，连接数据、凭据、被控画面及局域网设备信息永不离开本机。当前版本（v1.1.0）不采集、不上传任何诊断或遥测数据，也不包含崩溃自动上报功能。应用仅在本机 userData/logs 目录写入运行日志（仅保留最近 30 天）用于本地排障，日志中的路径、IP、主机名、凭据字段已做本地脱敏，不会自动上传。共享剪贴板与文件传输由系统/客户端原生能力承载，LanDesk 不读取、不缓存、不上传其任何内容。未来版本如引入匿名诊断上报，将采用默认关闭、需用户显式同意的方式，并在发布说明中提前告知。

## License

[MIT](./LICENSE)
