# 开发约定

## 定位与范围

- 产品是独立 Mihomo 管理器。UFI-TOOLS / Android 和 Linux / systemd 是两个平台；F50 只是设备实例。代理数据流始终由 Mihomo 处理。
- 库优先：通用能力先查现有依赖和成熟库；适用就采用。自写代码限于业务规则、所有权检查和必要平台适配。不要另写简化框架或兼容旧协议。
- README 面向用户并保持简短；Linux 操作说明在 docs/linux.md。开发决策维护于本文件，不保留 ref 源码或研究流水账。
- 本仓修改不授权操作用户现有网关。独立 Web、任意操作系统、自动 Linux 防火墙部署不在当前范围。

## 修改前定位

- 设备入口：cmd/mihomoctl 只处理进程入口，internal/cli 用 Cobra 装配平台、CLI 和 UFI 上传 Adapter。机器响应是 JSON；错误不得混入 usage。
- 共享 Module：internal/manager 管请求校验、持久任务、订阅、下载校验、配置事务与回滚。CLI 与解密后的 UFI 请求都调用 Submit；不能依赖浏览器串联关键步骤。设备操作统一使用顶层命令，默认等待完成，--no-wait 仅用于显式后台调用；UFI 自启调用 start --no-wait。
- 平台 Module：internal/platform 管 UFI 守护 / 网络桥接及 systemd 运行时。Adapter 配置由数据库持久化，worker、supervise 和自启任务都重新读取；已有安装不能通过环境或旗标换平台。
- 存储 Module：internal/storage 使用 sqlc + database/sql + modernc SQLite，拥有类型化状态表；YAML、日志和运行文件留在文件系统。fsutil、host、download、redact 是共享基础实现。
- 前端：ui/src/transport/ufi 只处理 UFI 通信和引导；gateway.ts 处理任务观察与展示；use-gateway.ts 管草稿和交互；components/ 管视图。CSS 仅留主题与宿主隔离，其余用 Tailwind className。
- 无样式交互组件统一使用 Base UI。Tailwind 4 使用官方 Vite 插件、ufi: 前缀和容器内的无 layer utilities；不加载 preflight，避免宿主样式覆盖插件或插件样式外溢。
- 修改加载协议时核对下方 UFI 官方来源；没有文档保证的行为不能从其他插件推断。
- UFI SDK 位于 ui/packages/ufi-sdk，拥有接口定义、运行时校验、签名和宿主适配；mihomoctl 按需导入，业务加密与命令退出标记仍归 transport。宿主入口使用 requests.js 的裸全局 originFetch，自行签名设备请求，缺失时明确报错；不调用 window.fetch 包装。修改 SDK 时核对其 README 中的源码／文档差异，测试覆盖全部路由清单和认证、上传、取消行为。

## 必须保持的约束

- UFI uploads 公开可读，Root Shell 会记录命令和响应。请求使用 libsodium sealed box；上传先校验文件类型、大小和摘要，再交给 Manager。明文订阅、配置、密钥不能进入公开文件、命令参数或响应日志。
- 本地 CLI 的秘密通过 JSON 文件 / stdin 传入，不通过 argv。结构化 params 拒绝未知字段与不适用参数；不保留旧 value 字段或嵌套 JSON。
- 密钥读取仍通过浏览器临时公钥加密响应。Dashboard 链接不携带密钥。SQLite 不是整库加密，私有目录、0600 数据库和秘密脱敏仍必需。
- Submit 持有 control.lock，将锁描述符传给 worker。worker 先等待启动 gate，接管后设置控制锁 FD_CLOEXEC，防止守护或内核继承控制锁；Linux 必须先进入 systemd scope 再放行，setsid 不能替代 cgroup 托管。
- 接收任务时，状态、密文、HMAC 防重放摘要和最新任务指针在同一 SQLite 事务提交。相同语义请求重新加密后仍识别同一 ID；不同内容复用 ID 必须拒绝。
- 进度和取消属于原任务：SQLite 保存下载字节、总量、速度、开始时间及取消标志。cancel 不获取 worker 持有的 control.lock、不创建新任务；取消接受与不可取消的提交边界通过条件 UPDATE 互斥，worker 通过 context 停止 I/O 并清理，不能用浏览器断开或强杀进程冒充取消。初装由引导脚本用任务目录内的控制锁串行化取消与安装交接，仅终止自己启动的 curl。
- 请求密文在完成后清理，防重放记录保留。丢失响应后只查询原 ID；ky 和任务提交都禁止自动重发。
- SQLite 连接从 Open 到 Close 持有 state.lock 共享锁；卸载关闭自己的连接后取得独占锁，排空观察者并阻止新 WAL/SHM 创建。普通 Open 使用 mode=rw，不能创建缺失数据库。
- 前端卸载入口独立于状态解析：直接调用设备现有 ctl 的 uninstall 控制命令，使用固定任务 ID 查询最小卸载回执，不读取或转换其他版本的运行状态。状态不可用时仍展示卸载入口及原始原因；所有删除由设备 ctl 按所有权规则完成。
- 卸载先完成平台清理，再删除文件，最后删除数据库和锁。成功后不能再写任务状态；前端以安装目录和平台额外目录确实消失确认完成。失败不能假报成功，不留卸载备份。
- 原始 YAML、本地覆写、运行 YAML 和元数据同属一个配置版本。先校验，再记录 journal，切换 current，重启并验证；失败恢复完整旧版本。SQLite 事务不能替代文件 / 进程回滚。
- 本地覆写使用私有 overrides.yaml：有配置时归属当前 generation，无配置时保存于 runtime；缺省使用基础管理设置。普通字段经 mergo 深度合并后交给 Mihomo 校验，平台必要监听与接管约束保留。编辑器读取通过 controller-secret --config 返回 sealed box；普通 status 不返回覆写明文。
- 保存完成、后台刷新、任务重连不能覆盖用户更新的草稿。运行状态和任务状态分开，完成提示不常驻首页。

## 平台所有权

- UFI 使用自己的链、mark 和路由，不清空系统防火墙或全局路由。启动内核前建立监听保护；等待 LAN 时仍保留保护，内核退出后才撤掉。
- UFI 防火墙路径与后端记录在私有 runtime/firewall.json，首次检查在 network.lock 内绑定；默认入口优先，缺失时仅接受唯一完整的 legacy/nft 配对，拒绝混合或后端变更。停止与卸载使用同一记录；不按其他代理规则猜测后端。启动前在未挂接链中验证实际 TPROXY、DNS、mark 与 IPv6 保护规则，失败保留清理证据；查询失败不能等同规则不存在。
- UFI 本机 IPv4 目的地址用显式 /32 规则排除，不依赖 addrtype 扩展；地址快照与活动规则同次提交，地址变化触发同步，规则切换期间保留监听保护。启动失败返回最后的就绪错误、仅本次新增的脱敏日志及清理失败原因。
- UFI 自动接口识别只接受共享入口，排除蜂窝、上游和 VPN；未知固件保留手动接口配置。能力标识不保证任意硬件已支持 TPROXY。
- Linux 使用 go-systemd 的 D-Bus 客户端和 unit 序列化；unit 源文件位于私有目录，通过 D-Bus 注册。操作前核对源文件、FragmentPath、有效 Id、ExecStart / argv、WorkingDirectory、KillMode 和命名空间设置；拒绝外部同名 unit、mask 和 drop-in，链接及启用不使用 force。ExecStart 使用 : 禁用环境变量展开，路径中的 % 仍需转义。
- 两平台均由 Agent 管理私有目录内的自身二进制和 Mihomo；下载、更新、自启为共有功能，能力标识仅表达 interfaces / capture 平台差异；共用下载、校验与更新流程，按平台和架构选择官方资产，不支持外部内核模式或旧状态迁移。Linux 的 service 安装、自启和卸载由 CLI 调用 systemd 完成；先停止、禁用并移除 unit，确认不再引用配置，再删除 Agent 数据。
- Linux 默认 loopback；显式 LAN 地址必须是本机 IPv4 私网地址。管理 API 仍绑定 loopback，额外 listeners / tunnels 不接受。私网地址绑定不证明入口隔离；network/capture 不得虚报就绪。
- systemd 启动提交或健康检查失败时，用新的有界 context 验证并停止本 unit，再进行配置回滚。不能遗留一次失败启动创建的监听。
- 平台依赖限于必要适配：Linux 用 systemd 托管进程、自启；网络与故障策略仍由用户配置。卸载仅清理本安装拥有的文件及 service 链接，不删除其他 unit、软件包或网络规则。

## 库与验证

- Cobra 管 CLI；renameio 管原子文件、二进制和符号链接替换；procfs 管进程解析；SQLite 管状态；go-github、semver 管发行信息。自更新用标准库校验 SHA-256，探测候选版本后写入同一份已验证字节，不重新读取候选路径。
- renameio 暂存必须同文件系统且初始私有，不沿用旧文件权限覆盖密钥。Android 公共自启文件的 chmod 可容忍 EPERM/EOPNOTSUPP，其余情况必须报错。
- DoH 使用 net/http 与 x/net/dnsmessage，保留引导 IP、Android CA、取消、HTTPS 重定向限制与响应上限。解压使用标准库，调用方保留路径、类型和大小限制。
- modernc.org/libc 必须与所用 modernc.org/sqlite 的 go.mod 匹配；保持 CGO_ENABLED=0 和 ARM64 / ARMv7 / AMD64 构建。
- Go、Bun、just、sqlc、GoReleaser 和检查工具的版本集中在 mise.toml，CI 通过 mise 安装；Vitest 与 Playwright 驱动是 ui/ 的锁定开发依赖，GitHub Actions 固定完整提交 SHA。
- SQLite 的 schema.sql 同时用于初始化与 sqlc；queries.sql 生成 internal/storage/db，生成文件随源码提交，just check 用 sqlc diff 校验。事务与状态锁归 storage，生成层不依赖 Manager；仅不兼容的持久状态格式变更升级 schema、机器请求或响应契约变更升级协议，旧安装重装。内部实现、界面及缺陷修复保留协议与 schema；相同协议与 schema 的补丁必须支持原位更新。
- 版本检查快照持久化 SQLite；status 用实际安装版本重新比较缓存 latest，不写回快照或检查时间，check-updates 才显式联网保存结果。比较统一使用 Go semver；前端仅展示与当前版本一致的比较。
- 根目录为 Go module，前端包与测试独立位于 ui/。构建与验证入口见 justfile；Go 构建不能依赖 Bun 或前端资产；go.mod 用 ignore ./ui 排除前端依赖中附带的 Go 示例，保持 test/tidy 的边界。
- 交互修改运行 just test-ui；ui/tests/browser 使用 Vitest Browser Mode 和 Playwright 驱动，通过真实 DOMParser 加载生产 IIFE，并验证窄屏布局与宿主隔离。ui/tests/native.test.ts 在 Bun 运行的 Vitest node 项目中验证前端请求 → 纯 Go CLI；platform 测试替换 D-Bus；真实 systemd 验证仅在隔离 CI runner 通过 MIHOMOCTL_SYSTEMD_TEST 显式启用。
- 浏览器测试通过官方 [frameLocator](https://vitest.dev/api/browser/context#framelocator) 操作同源应用 iframe；仅刷新应用 iframe，不导航 Vitest 运行器。同文件用例顺序执行，每例清理专属 sessionStorage 并收集应用异常；[失败截图和 trace](https://vitest.dev/guide/browser/playwright-traces) 由 Vitest 管理。
- CI systemd fixture 只监听 loopback 测试端口，不发送代理流量或改路由 / 防火墙。不得把它描述为真实网关流量验证。

## 发布

- 使用 mise 的官方 Go 与 GoReleaser；构建环境、架构、资产及校验以 .goreleaser.yaml 为准，工具版本以 mise.toml 为准。just snapshot 用于预览，just release 从当前 Git 标签构建且不上传；Release workflow 完成检查后发布，已有标签和资产不可覆盖。
- 发行来源仍校验 GitHub 官方 API 和 Release 地址；可选 releaseProxy 使用 netnr/workers cors.js 的 `/encodeURIComponent(完整 URL)` 协议，入口只接受公开 HTTPS origin。浏览器初装、设备引导及三组件请求共用此设置，安装后持久化 SQLite；订阅与 UFI 私有通信独立。浏览器省略凭据，转发由服务端完成重定向；Go 专用发行客户端负责映射，普通下载客户端不转发。保留摘要、大小与协议校验，README 明确同源摘要的信任边界；后续 Agent 更新统一走 Manager。
- 发布前通过 Check 和 Release CI；从公开地址下载所有资产，校验 SHA256SUMS 并与本地构建对比。插件保持单 JS，不增加 CDN / WASM 请求。
- 项目与 Go module 统一命名为 mihomoctl；UFI 插件资产为 mihomoctl-ufi.js。只维护当前名称、目录和协议，不提供历史别名或状态迁移。

## UFI 官方来源

以 http-server-version 分支为准：

- [API](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/API_Doc.md)：Root Shell、认证、上传。
- [用户文档](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/User_Doc.md)：插件导入、自启。
- [加载器](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/frontEnd/public/script/main.js)：DOMParser 和脚本包装。
- [请求实现](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/frontEnd/public/script/requests.js)：HTTP 成功不等于命令成功。
- [上传实现](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/src/main/java/com/minikano/f50_sms/modules/theme/themeModule.kt)：公开 uploads。
