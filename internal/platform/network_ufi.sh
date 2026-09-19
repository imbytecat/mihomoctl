#!/system/bin/sh
# UFI Android network adapter. Only these chains, mark bit and table belong to us.
DIR=$1
ACTION=$2
IPT=$3
IP6T=$4
CTL=$5
alive() {
  pid=$(cat "$DIR/core.pid" 2>/dev/null)
  case "$pid" in ''|*[!0-9]*) return 1;; esac
  [ "$pid" -gt 1 ] && kill -0 "$pid" 2>/dev/null && [ "$(readlink "/proc/$pid/exe")" = "$DIR/mihomo" ]
}
MARK=0x40000000
TABLE=2026
PRIORITY=9000

ipt() { "$IPT" -w 5 "$@"; }
ip6t() { "$IP6T" -w 5 "$@"; }

resolve_interfaces() {
  configured=$(cat "$DIR/interfaces" 2>/dev/null)
  if [ -n "$configured" ] && [ "$configured" != auto ]; then
    # shellcheck disable=SC2086
    for iface in $configured; do
      case "$iface" in lo|rmnet*|ccmni*|pdp*|wwan*|*[!a-zA-Z0-9_.-]*|[-.]*) return 1;; esac
      [ "${#iface}" -le 15 ] || return 1
    done
    printf '%s\n' "$configured"
    return
  fi
  # Android keeps upstream routes outside the main table. Include IPv6-only uplinks.
  routes=$(ip -4 route show table all) || return 1
  routes6=$(ip -6 route show table all) || return 1
  upstreams=$(printf '%s\n%s\n' "$routes" "$routes6" | awk '
    $1 == "default" || $1 == "0.0.0.0/1" || $1 == "128.0.0.0/1" {
      for (i=1; i<NF; i++) if ($i == "dev") printf "%s ", $(i+1)
    }')
  addresses=$(ip -o -4 addr show up scope global) || return 1
  # ponytail: F50 Wi-Fi/USB/bridge names + private IPv4; unknown firmware names need an override.
  printf '%s\n' "$addresses" | awk -v upstreams="$upstreams" '
    BEGIN { n=split(upstreams, list, " "); for (i=1; i<=n; i++) upstream[list[i]]=1 }
    {
      iface=$2; sub(/@.*/, "", iface)
      if (iface !~ /^(wlan[0-9]+|ap[0-9]+|softap[0-9]*|rndis[0-9]+|usb[0-9]+|br[0-9]+|br-lan)$/ || upstream[iface]) next
      split($4, addr, /[.\/]/)
      if (addr[1]==10 || (addr[1]==172 && addr[2]>=16 && addr[2]<=31) || (addr[1]==192 && addr[2]==168)) print iface
    }' | sort -u | tr '\n' ' ' | sed 's/ *$//'
}

local_ipv4() {
  addresses=$(ip -o -4 addr show) || { echo '无法读取本机 IPv4 地址' >&2; return 1; }
  printf '%s\n' "$addresses" | awk '$3 == "inet" { split($4, addr, "/"); print addr[1] }' | sort -u | tr '\n' ' ' | sed 's/ *$//'
}

network_sync() {
  selected=$(resolve_interfaces) || { pause_capture; return 1; }
  local_addresses=$(local_ipv4) || { pause_capture; return 1; }
  listeners_ready || { pause_capture; return $?; }
  if [ "$local_addresses" != "$(active_addresses)" ]; then pause_capture || return 1; fi
  # An old downstream may have become an upstream. Do not keep capturing it on rollback.
  previous_interfaces=$(active_interfaces)
  for previous_iface in $previous_interfaces; do
    case " $selected " in *" $previous_iface "*) ;; *) pause_capture || return 1; break;; esac
  done
  if [ "$selected" != "$(active_interfaces)" ] || [ "$local_addresses" != "$(active_addresses)" ] || ! network_ok; then
    network_start || return 1
  fi
}

active_slot() { sed -n '1p' "$DIR/network.active" 2>/dev/null; }
active_interfaces() { sed -n '2p' "$DIR/network.active" 2>/dev/null; }
active_addresses() { sed -n '3p' "$DIR/network.active" 2>/dev/null; }

# Detach traffic before changing a former LAN into an upstream. Keep INPUT guards.
table_snapshot() {
  snapshot=$("$1" -t "$2" -S) || { echo "无法读取防火墙表：$1 $2" >&2; return 1; }
  printf '%s\n' "$snapshot"
}

remove_hook() {
  while :; do
    snapshot=$(table_snapshot "$1" "$2") || return 1
    printf '%s\n' "$snapshot" | grep -qxF -- "-A $3 -j $4" || return 0
    "$1" -t "$2" -D "$3" -j "$4" || return 1
  done
}

pause_capture() {
  remove_hook ipt mangle PREROUTING UFI_MH && remove_hook ipt nat PREROUTING UFI_MH_DNS
}

network_state() {
  result=$("$CTL" network-state "$1" "$TABLE" "$PRIORITY" "$MARK") || { echo "网络检查 $1 失败：$result" >&2; return 1; }
  case "$result" in true|false) printf '%s\n' "$result";; *) echo "网络检查 $1 响应无效：$result" >&2; return 1;; esac
}

# The file descriptors prove these sockets belong to our core, not another process.
listeners_ready() {
  alive core || return 1
  listener_pid=$(cat "$DIR/core.pid")
  socket_inodes=$(for fd in /proc/"$listener_pid"/fd/*; do readlink "$fd" 2>/dev/null; done |
    sed -n 's/^socket:\[\([0-9]*\)\]$/\1/p' | tr '\n' ' ')
  [ -n "$socket_inodes" ] || return 1
  api_port=$(cat "$DIR/current/api-port" 2>/dev/null)
  case "$api_port" in ''|0) api_hex='';; *[!0-9]*) return 1;; *) api_hex=$(printf '%04X' "$api_port") || return 1;; esac
  awk -v owned="$socket_inodes" -v api="$api_hex" '
    BEGIN { n=split(owned, ids, " "); for(i=1;i<=n;i++) inode[ids[i]]=1 }
    inode[$10] {
      split($2, localaddr, ":")
      if (localaddr[1] !~ /^0+$/) next
      port=toupper(localaddr[2]); proto=FILENAME ~ /udp6?$/ ? "udp" : "tcp"
      if ((proto=="tcp" && $4=="0A") || (proto=="udp" && $4=="07")) found[proto,port]=1
    }
    END { exit !(found["tcp","1ED6"] && found["udp","1ED6"] && found["tcp","041D"] && found["udp","041D"] && (api=="" || found["tcp",api])) }
  ' /proc/net/tcp /proc/net/udp /proc/net/tcp6 /proc/net/udp6 2>/dev/null
}

network_stop() {
  [ -f "$DIR/network.owned" ] || return 0
  network_tools || return 1
  for group in 'ipt mangle PREROUTING UFI_MH' 'ipt nat PREROUTING UFI_MH_DNS' 'ip6t filter FORWARD UFI_MH6' 'ipt filter INPUT UFI_MH_IN' 'ip6t filter INPUT UFI_MH_IN6'; do
    # shellcheck disable=SC2086
    set -- $group
    remove_hook "$1" "$2" "$3" "$4" || return 1
    snapshot=$(table_snapshot "$1" "$2") || return 1
    if printf '%s\n' "$snapshot" | grep -qxF -- "-N $4"; then "$1" -t "$2" -F "$4" || return 1; fi
    for chain in "${4}_A" "${4}_B" "$4"; do
      if printf '%s\n' "$snapshot" | grep -qxF -- "-N $chain"; then
        "$1" -t "$2" -F "$chain" && "$1" -t "$2" -X "$chain" || return 1
      fi
    done
    snapshot=$(table_snapshot "$1" "$2") || return 1
    if printf '%s\n' "$snapshot" | grep -Eq "^-N ($4|${4}_A|${4}_B)$"; then echo "网络链未完全清理：$4" >&2; return 1; fi
  done
  while :; do
    owned=$(network_state rule-owned) || return 1
    [ "$owned" = true ] || break
    ip -4 rule del priority "$PRIORITY" fwmark "$MARK/$MARK" table "$TABLE" || return 1
  done
  owned=$(network_state route-owned) || return 1
  if [ "$owned" = true ]; then
    ip -4 route del local 0.0.0.0/0 dev lo table "$TABLE" || return 1
  fi
  route=$(network_state route-owned) || return 1
  rule=$(network_state rule-owned) || return 1
  if [ "$route" = true ] || [ "$rule" = true ]; then
    echo '网络路由未完全清理，保留运行文件' >&2; return 1
  fi
  rm -f "$DIR/network.active" "$DIR/network.pending" "$DIR/network.active.next" "$DIR/network.owned"
}

build_slot() {
  # Android may omit multiport; expand the same protected set into basic port matches.
  case "$PROTECTED_PORTS" in ,*|*,|*,,*) echo '监听保护端口列表无效' >&2; return 1;; esac
  protected_ports=$(printf '%s' "$PROTECTED_PORTS" | tr ',' ' ') || return 1
  for group in 'ipt mangle UFI_MH' 'ipt nat UFI_MH_DNS' 'ip6t filter UFI_MH6' 'ipt filter UFI_MH_IN' 'ip6t filter UFI_MH_IN6'; do
    # shellcheck disable=SC2086
    set -- $group
    snapshot=$(table_snapshot "$1" "$2") || return 1
    if printf '%s\n' "$snapshot" | grep -qxF -- "-N ${3}_$next"; then
      "$1" -t "$2" -F "${3}_$next" || return 1
    else "$1" -t "$2" -N "${3}_$next" || return 1; fi
  done
  ipt -A "UFI_MH_IN_$next" -i lo -j RETURN || return 1
  ip6t -A "UFI_MH_IN6_$next" -i lo -j RETURN || return 1
  # Enumerate assigned addresses: Android's iptables may omit the addrtype match.
  for address in $local_addresses; do
    ipt -t mangle -A "UFI_MH_$next" -d "$address/32" -j RETURN || return 1
  done
  for subnet in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4; do
    ipt -t mangle -A "UFI_MH_$next" -d "$subnet" -j RETURN || return 1
  done
  # Interface names are validated in both the UI and service entry point.
  # shellcheck disable=SC2086
  for iface in $selected; do
    ipt -A "UFI_MH_IN_$next" -i "$iface" -m mark --mark "$MARK/$MARK" -j ACCEPT || return 1
    for proto in tcp udp; do
      for port in $protected_ports; do
        ipt -A "UFI_MH_IN_$next" -i "$iface" -p "$proto" --dport "$port" -j ACCEPT || return 1
        ip6t -A "UFI_MH_IN6_$next" -i "$iface" -p "$proto" --dport "$port" -j ACCEPT || return 1
      done
      ipt -t mangle -A "UFI_MH_$next" -i "$iface" -p "$proto" ! --dport 53 -j TPROXY --on-port 7894 --tproxy-mark "$MARK/$MARK" || return 1
      ipt -t nat -A "UFI_MH_DNS_$next" -i "$iface" -p "$proto" --dport 53 -j REDIRECT --to-ports 1053 || return 1
    done
    ip6t -A "UFI_MH6_$next" -i "$iface" -j REJECT --reject-with icmp6-adm-prohibited || return 1
  done
  for proto in tcp udp; do
    for port in $protected_ports; do
      ipt -A "UFI_MH_IN_$next" -p "$proto" --dport "$port" -j REJECT || return 1
      ip6t -A "UFI_MH_IN6_$next" -p "$proto" --dport "$port" -j REJECT || return 1
    done
  done
}

# Set INPUT/IPv6 protection before DNS and TProxy capture. Each jump replacement is atomic.
switch_slot() {
  slot=$1
  for group in 'ipt filter INPUT UFI_MH_IN' 'ip6t filter INPUT UFI_MH_IN6' 'ip6t filter FORWARD UFI_MH6' 'ipt nat PREROUTING UFI_MH_DNS' 'ipt mangle PREROUTING UFI_MH'; do
    # shellcheck disable=SC2086
    set -- $group
    snapshot=$(table_snapshot "$1" "$2") || return 1
    printf '%s\n' "$snapshot" | grep -qxF -- "-N $4" || "$1" -t "$2" -N "$4" || return 1
    wrapper_rules=$("$1" -t "$2" -S "$4") || return 1
    entries=$(printf '%s\n' "$wrapper_rules" | awk '$1=="-A" {n++} END {print n+0}')
    case "$entries" in
      0) "$1" -t "$2" -A "$4" -j "${4}_$slot" || return 1;;
      1) "$1" -t "$2" -R "$4" 1 -j "${4}_$slot" || return 1;;
      *) echo '入口链状态异常，请停止代理后重试' >&2; return 1;;
    esac
    printf '%s\n' "$snapshot" | grep -qxF -- "-A $3 -j $4" || "$1" -t "$2" -I "$3" 1 -j "$4" || return 1
  done
}

network_routes_ok() {
  rule=$(network_state rule-owned) || return 1
  route=$(network_state route-owned) || return 1
  [ "$rule" = true ] && [ "$route" = true ]
}

network_ok() {
  slot=$(active_slot)
  case "$slot" in A|B) ;; *) return 1;; esac
  [ ! -f "$DIR/network.pending" ] || return 1
  for group in 'ipt mangle PREROUTING UFI_MH' 'ipt nat PREROUTING UFI_MH_DNS' 'ip6t filter FORWARD UFI_MH6' 'ipt filter INPUT UFI_MH_IN' 'ip6t filter INPUT UFI_MH_IN6'; do
    # shellcheck disable=SC2086
    set -- $group
    "$1" -t "$2" -C "$3" -j "$4" >/dev/null 2>&1 || return 1
    "$1" -t "$2" -C "$4" -j "${4}_$slot" >/dev/null 2>&1 || return 1
  done
  network_routes_ok
}

claim_network() {
  [ ! -f "$DIR/network.owned" ] || return 0
  empty=$(network_state table-empty) || return 1
  [ "$empty" = true ] || { echo '策略路由表已被其他程序占用' >&2; return 1; }
  free=$(network_state priority-free) || return 1
  [ "$free" = true ] || { echo '策略路由优先级已被占用' >&2; return 1; }
  for group in 'ipt mangle UFI_MH' 'ipt nat UFI_MH_DNS' 'ip6t filter UFI_MH6' 'ipt filter UFI_MH_IN' 'ip6t filter UFI_MH_IN6'; do
    # shellcheck disable=SC2086
    set -- $group
    snapshot=$(table_snapshot "$1" "$2") || return 1
    if printf '%s\n' "$snapshot" | grep -Eq "^-N ($3|${3}_A|${3}_B)$"; then echo "同名网络链已存在：$3" >&2; return 1; fi
  done
  touch "$DIR/network.owned"
}

# Compile the exact required rules in unhooked owned chains before starting core.
network_check() {
  network_tools && network_stop && claim_network || return 1
  next=A
  selected=lo
  local_addresses=$(local_ipv4) || return 1
  result=0
  build_slot || result=$?
  network_stop || { echo '能力检查后的清理失败' >&2; return 1; }
  [ "$result" = 0 ] || { echo '防火墙规则检查失败，请查看上方具体错误' >&2; return "$result"; }
}

network_start() {
  network_tools || return 1
  local_addresses=$(local_ipv4) || return 1
  if [ "${ACTION:-sync}" = prepare ]; then
    selected=''
  else
    selected=$(resolve_interfaces) || return 1
    listeners_ready || return 1
  fi
  old=$(active_slot)
  case "$old" in A) next=B;; B) next=A;; '') next=A;; *) return 1;; esac
  if [ -f "$DIR/network.pending" ]; then
    if [ -n "$old" ]; then switch_slot "$old" || return 1; else network_stop || return 1; fi
    rm -f "$DIR/network.pending"
  fi
  claim_network || return 1
  if ! network_routes_ok; then
    # Only add missing owned routes; never replace foreign entries.
    empty=$(network_state table-empty) || return 1
    if [ "$empty" = true ]; then
      ip -4 route add local 0.0.0.0/0 dev lo table "$TABLE" || return 1
    fi
    free=$(network_state priority-free) || return 1
    if [ "$free" = true ]; then
      ip -4 rule add priority "$PRIORITY" fwmark "$MARK/$MARK" table "$TABLE" || return 1
    fi
    network_routes_ok || return 1
  fi
  build_slot || return 1
  printf '%s\n' "$next" > "$DIR/network.pending" || return 1
  if switch_slot "$next"; then
    if printf '%s\n%s\n%s\n' "$next" "$selected" "$local_addresses" > "$DIR/network.active.next" &&
      mv "$DIR/network.active.next" "$DIR/network.active"; then
      rm -f "$DIR/network.pending"
      return 0
    fi
  fi
  if [ -n "$old" ]; then
    switch_slot "$old" || { echo '网络规则回滚失败，将重试' >&2; return 1; }
    rm -f "$DIR/network.pending"
  else network_stop || return 1; fi
  return 1
}

network_tools() {
  for tool in ip "$IPT" "$IP6T" "$CTL"; do
    command -v "$tool" >/dev/null 2>&1 || { echo "缺少系统命令：$tool" >&2; return 1; }
  done
  for group in 'ipt mangle' 'ipt nat' 'ipt filter' 'ip6t filter'; do
    # shellcheck disable=SC2086
    set -- $group
    table_snapshot "$1" "$2" >/dev/null || return 1
  done
}

PROTECTED_PORTS=$(cat "$DIR/current/ports" 2>/dev/null)
case "$PROTECTED_PORTS" in ''|*[!0-9,]*) PROTECTED_PORTS=7894,1053;; esac
case "$ACTION" in
  check) network_check;;
  prepare) network_start;;
  sync) network_sync;;
  stop) network_stop;;
  ready)
    alive || { echo 'Mihomo 内核进程未运行'; exit 1; }
    listeners_ready || { echo '内核监听未就绪，请检查 DNS、TPROXY 和控制端口及内核日志'; exit 1; }
    network_ok || { echo '本安装的网络规则或策略路由未就绪'; exit 1; }
    ;;
  inspect)
    listening=false; captured=false
    listeners_ready && listening=true
    if [ -n "$(active_interfaces)" ] && network_ok; then captured=true; fi
    printf '{"listeners":%s,"network":%s}\n' "$listening" "$captured"
    ;;
  *) exit 1;;
esac
