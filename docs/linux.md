# Linux

mihomoctl 自行安装、校验和更新 Mihomo 与自身二进制，管理订阅、配置版本、任务、启停和自启。需要 root；进程托管和开机启动通过 systemd 的 D-Bus 接口完成，无需手写 service 或预装 Mihomo。

## 安装与日常操作

安装、订阅、内核更新和卸载命令见 [README](../README.md#linux-安装)。默认目录为 `/var/lib/mihomoctl`，后续直接使用其中的 `mihomoctl`。`install` 只初始化 mihomoctl 和 service，首次内核下载使用 `download`。

安装参数仅在首次安装时确定，后续命令从数据库读取：

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `--root` | `/var/lib/mihomoctl` | 私有数据目录，末级名称必须为 `mihomoctl` |
| `install --unit` | `mihomoctl-core.service` | 独立 service 名称，已有同名服务时拒绝覆盖 |
| `install --listen-address` | `127.0.0.1` | 本机回环或 IPv4 私网地址 |

例如安装到另一目录并监听本机 LAN 地址：

```sh
sudo ./mihomoctl-linux-amd64 --root /opt/mihomoctl install \
  --unit mihomoctl-lan.service --listen-address 192.168.1.2
```

自定义目录安装后，后续命令也传同一个 `--root`。下载会按架构选择官方 Linux 资产；AMD64 使用兼容版，不要求新 CPU 指令集。内核和 mihomoctl 更新均需先执行 `stop`，成功后用 `start` 启动。

如需发行转发，可在安装时加 `--release-proxy https://mirror.example.com`，指向自行部署的 [netnr/workers cors.js](https://github.com/netnr/workers)。安装后使用 `save-release-proxy --input 文件` 保存 `{"releaseProxy":"https://mirror.example.com"}`，空字符串恢复直连。设置保存在设备 SQLite，后台任务和三组件版本检查、下载都会读取；订阅不走转发。入口只接受无路径、参数及凭据的 HTTPS 域名。

当前数据库 schema 为 7、协议为 9；旧安装须先用原安装目录内的 CLI 卸载，再用新二进制安装，不迁移旧状态。

长下载可用 `--no-wait` 提交，通过 `job ID` 查看字节进度和取消状态，`job-log ID` 查看带时间的日志；`cancel ID` 请求取消并等待清理。取消仅在下载／准备阶段接受，提交安装或应用配置后会拒绝取消；不会关闭正在运行的代理。

## 监听与面板

默认只监听 `127.0.0.1`。LAN 地址必须实际存在于本机接口；地址绑定不等于入口隔离。转发、TPROXY、DNS 接管、IPv6 和故障策略仍需配置系统网络和防火墙，mihomoctl 不会自动部署这些规则，也不会显示“已接管网络”。`diagnose` 使用系统 `ip` 命令读取网络信息，`logs` 汇总 `journalctl` 的 service 日志与 `runtime/tasks.log` 的任务记录。

管理 API 固定绑定本机回环地址。需要 Zashboard 时执行 `download-dashboard`，通过 SSH 转发访问：

```sh
ssh -N -L 9090:127.0.0.1:9090 root@设备地址
```

浏览器打开 `http://127.0.0.1:9090/ui/`。使用 `save-controller --input 文件` 设置自己的密钥，JSON 文件权限保持 `0600`：

```json
{"controller":{"enabled":true,"port":9090,"secret":"your-key"}}
```

在面板连接页输入所设置的密钥；UFI 插件的「打开面板」会自动填入当前连接信息。

## 自启与卸载

配置和内核就绪后，使用 `boot-on` 开启自启，`boot-off` 关闭。mihomoctl 在私有目录保存 service 文件，通过 systemd 注册；无需手动执行 `systemctl enable` 或 `daemon-reload`。勿修改该 service 或添加 drop-in，mihomoctl 会拒绝操作身份或配置不符的服务。

`uninstall` 自动停止内核、关闭自启并移除 service，确认 systemd 不再引用安装目录后删除 mihomoctl、内核及全部数据。清理失败会报错并保留尚未删除的数据，可修复原因后重试。无备份；其他服务和系统网络规则不受影响。
