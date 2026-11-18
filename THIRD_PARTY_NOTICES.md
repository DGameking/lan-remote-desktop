# 第三方组件与许可声明（THIRD_PARTY_NOTICES.md）

LanDesk 自研代码采用 MIT 许可证。本项目**不复制、不内嵌、不重新分发**下列 GPL/AGPL 组件的任何代码或二进制；仅通过命令行调起用户在自己机器上独立安装的客户端程序。进程间调用不构成衍生作品。

| 组件 | 用途 | 许可 | 集成方式 | 分发边界 |
|------|------|------|----------|----------|
| mstsc.exe | RDP 连接 Windows | Windows 系统组件 | 调起系统自带程序 | 不分发 |
| TigerVNC / x11vnc Viewer | VNC 连接 macOS/Linux/fnOS | GPL-2.0 | 调起用户自装客户端 | **不随包分发** |
| RealVNC / TightVNC Viewer | VNC 客户端（可选） | 各自许可 | 调起用户自装客户端 | **不随包分发** |
| RustDesk | 可选远程连接 | AGPL-3.0 | 命令行/URL 调起用户自装官方客户端 | **禁止内嵌/捆绑/修改/再分发** |
| FreeRDP | 未使用 | Apache-2.0 | 未集成 | — |
| noVNC | 未使用 | MPL-2.0 | 未集成 | — |

## 直接依赖（npm，随构建打包，均为宽松许可）
| 依赖 | 许可 | 用途 |
|------|------|------|
| electron | MIT | 桌面运行时 |
| vue | MIT | UI 框架 |
| element-plus | MIT | UI 组件库 |
| sql.js | MIT | SQLite WASM 实现 |
| bonjour-service | MIT | mDNS 服务发现 |
| electron-vite / electron-builder / typescript / vitest | MIT | 构建与测试工具链 |

如遇许可合规疑问，请以各组件官方 LICENSE 为准。本项目 maintainer 保留在收到权利人通知后移除任何争议组件的权利。
