# 21｜RustDesk 自托管与会话码接入指引（v1.9.0 / 方案 2b）

> 版本：v1.0｜日期：2026-11-25｜状态：已实现（用户 2026-11-25 拍板方案 2b）
> 触发：用户在 `docs/17` 评估后确认"做"，选定推荐方案 2b——会话码/ID 连接入口以外部调起方式纳入。
> 口径：LanDesk 主体仍为纯局域网、无服务端、零遥测主控端；本文只描述"会话码外部调起入口"与"可选自托管 RustDesk Server"的用户侧配置，**LanDesk 不内嵌、不捆绑、不修改任何 AGPL 代码，不建信令/中继/账号**。
> 关联：`docs/02c`（冻结验收）、`docs/11`（负向清单）、`docs/16`（A/B/C 分层）、`docs/17`（C 类可行性评估）、`README.md`。

---

## 一、决策与范围

### 1.1 用户拍板结果

- 用户在 v1.8.0 交付后明确回复"做啊"，确认执行 `docs/17` 第七节的前置决策，选定**方案 2b：可选自托管 RustDesk ID 服务器 + 外部调起**。
- 依据 `docs/17` §5 推荐与 §7.1 前置项：仅"会话码/ID 连接入口"纳入，其余 C 项（自研 P2P 栈、自研中继、账号/2FA、无人值守 Agent、自研 E2EE/文件/剪贴板、跨网自研、会话录像）仍不做。

### 1.2 实现范围（主控端）

| 能力 | 是否实现 | 由谁提供 |
|---|---|---|
| 会话码输入框（快速连接对话框） | ✅ | LanDesk（纯 UI） |
| 会话码白名单校验与规范化 | ✅ | LanDesk（`src/shared/rustdesk-id.ts`） |
| `--connect=<码> --protocol=rustdesk` 命令行预填 | ✅ | LanDesk |
| `landesk://connect?id=<码>&protocol=rustdesk` 链接预填 | ✅ | LanDesk |
| 调起本机 RustDesk 官方客户端 `--connect <id>` | ✅ | LanDesk 编排 + 官方客户端 |
| 回退 `rustdesk://<码>` 协议链接 | ✅ | 官方客户端 |
| 会话码/P2P/中继本体 | ❌ 不自研 | RustDesk 官方客户端 + 其服务端 |
| 自托管 ID/relay 服务器 | ❌ 不在产品内 | 用户自行部署（见第三节） |

### 1.3 已修订的冻结口径文档

按 `docs/17` §7.1 要求同步修订：

- `docs/16` §四/§五/§六：C 类结论从"默认不做"更新为"会话码入口按 2b 有条件纳入，其余仍不做"。
- `docs/11` §3/§4：会话码行从"【明确不做】"改为"【外部调起入口】/【自研明确不做】"，并注明 v1.9 例外。
- `README.md`：新增「跨网与自托管 RustDesk」章节 + 能力归属披露。
- `docs/02c`：**无需修改**——外部调起不涉及自研被控端/服务端，冻结验收口径不变（与 `docs/17` §7.1 第 3 条一致）。

---

## 二、会话码安全边界（主控端）

### 2.1 白名单规则

`normalizeRustdeskId()` / `isRustdeskId()`（`src/shared/rustdesk-id.ts`）：

- 允许：字母、数字、下划线、连字符，长度 1–64（`^[A-Za-z0-9_-]{1,64}$`），首尾空白 trim。
- 拒绝：空格、点、冒号、斜杠、反斜杠、查询串、`&`/`;`/`|`/反引号/`$`/尖括号/`!`、`javascript:`、`rustdesk://` 等一切 URL / shell / 注入字符。
- 非字符串、超长一律判非法，**不抛异常**，调用方按"拒绝"处理。

### 2.2 分层拦截（纵深防御）

1. **预填层**（`src/shared/deeplink.ts`）：仅当显式 `protocol=rustdesk` 时，目标才可按会话码解析；`landesk://connect?id=<码>` 与 `--connect=<码> --protocol=rustdesk` 均走白名单。非 rustdesk 协议维持严格 IPv4 校验，不受影响。
2. **IPC 层**（`src/main/ipc/validators.ts` `validateConnectRequest`）：仅 rustdesk 协议放宽 IP 校验以容纳会话码；其余协议强制 IPv4；非 rustdesk 请求携带的 `rustdeskId` 被丢弃，避免串味。
3. **适配器层**（`src/main/protocols/rustdesk.ts`）：再次规范化；非法会话码抛错且不调起任何外部进程/URL。会话码作为独立 argv 参数 `['--connect', id]` 传入，**不拼 shell 命令字符串**；`rustdesk://<码>` 回退用 `encodeURIComponent` 作纵深防御。
4. **日志层**：会话码按既有 `IP_KEYS` 脱敏策略处理，不写明文凭据。RustDesk 凭据由官方客户端管理，LanDesk 不入库。

### 2.3 兼容边界

- 历史上用 IPv4 承载 RustDesk 目标的调用方仍兼容（适配器识别 IPv4 形态并透传）。
- 会话码含冒号（如 `123456789:5900`）会被白名单拒绝——端口对会话码无意义，属预期行为。
- RustDesk 会话码密码、2FA 等由官方客户端与服务端处理；LanDesk 不接触、不保存、不宣称提供。

---

## 三、自托管 RustDesk Server OSS（用户可选，官方口径）

> 以下为 RustDesk 官方文档（抓取 2026-11-25）的操作摘要，**仅供用户自行部署参考**。LanDesk 不提供服务器、不托管、不代为运维。官方原文以 `https://rustdesk.com/docs/en/self-host/rustdesk-server-oss/` 为准。

### 3.1 安装（官方推荐 Docker）

```bash
bash <(wget -qO- https://get.docker.com)
wget rustdesk.com/oss.yml -O compose.yml
sudo docker compose up -d
```

官方 Docker 页面也给出等价的手动 compose（`rustdesk/rustdesk-server:latest`，`hbbs` + `hbbr` 两个服务，`network_mode: host`，`./data:/root` 卷）。`hbbs` 负责 ID 注册/心跳与 TCP 打洞，`hbbr` 负责中继。

### 3.2 端口（官方原文）

| 端口 | 协议 | 用途 | 是否必需 |
|---|---|---|---|
| 21115 | TCP | NAT 类型测试 | 必需 |
| 21116 | TCP + UDP | UDP 用于 ID 注册与心跳；TCP 用于打洞与连接 | **必需（TCP/UDP 都要开）** |
| 21117 | TCP | 中继服务（hbbr） | 必需 |
| 21114 | TCP | Web 控制台，仅 Pro 版 | OSS 不用 |
| 21118 / 21119 | TCP | Web 客户端支持 | 不用 Web 客户端时关闭 |

官方防火墙示例：`ufw allow 21114:21119/tcp`、`ufw allow 21116/udp`。若启用 Web 客户端，21118/21119 只允许反向代理访问；不用则保持关闭。

### 3.3 客户端配置

安装结束记下服务端显示的 **IP/DNS** 与 **Key**，在双方 RustDesk 客户端进入「设置 → 网络 → ID/Relay 服务器」，在 `ID server` 与 `Key` 字段填入，其余留空。连通后对端 ID（会话码）即可在 LanDesk v1.9 的会话码入口使用。

### 3.4 许可与责任（如实披露）

- RustDesk 客户端与 Server OSS 为 **AGPL-3.0**；运行未修改版本不触发 AGPL §13 对外提供源码义务，一旦修改并对外提供网络交互即触发。
- LanDesk 仅通过进程间调用/协议链接调起**独立安装**的官方客户端，按规定不内嵌、不捆绑、不修改、不重新分发其代码，进程间调用不构成衍生作品。
- 自托管服务器的安全、可用、带宽与数据由**用户自己**承担；LanDesk 不连接、不监控、不采集该服务器任何信息。
- 官方依据见 `docs/17` §6 的来源表；以上非法律意见，具体合规适用请法务复核。

---

## 四、验证口径

- `src/shared/rustdesk-id.ts` 白名单与 `deeplink.ts`/`validators.ts` 分层校验：单测 `tests/v19-rustdesk-session.test.ts` 覆盖。
- `RustDeskAdapter.connect()` 真实接线：独立验证 `tests/v19-rustdesk-adapter.test.ts` 用 mock 断言 argv、`rustdesk://` 回退、非法会话码拦截与能力归属披露文案。
- 全量 `typecheck` / `typecheck:vue` / `test:unit` / `build` / `dist` 通过后方可发布。
- 本指引的官方端口/镜像/配置取自 RustDesk 官方文档（2026-11-25 抓取）；如官方更新，以官方为准并回头修订本文。
