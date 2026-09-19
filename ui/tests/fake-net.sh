# Stateful iptables/ip stand-in. Used only by tests; never runs host network commands.
fake_iptables() {
  family=$1; shift
  table=filter
  if [ "$1" = -t ]; then table=$2; shift 2; fi
  operation=$1; shift
  chain=${1:-}; [ "$#" = 0 ] || shift
  if [ "$operation" = -S ] && [ -f "$DIR/fail-query" ]; then echo 'permission denied reading table' >&2; return 1; fi
  if [ "$operation" = -D ] && [ -f "$DIR/fail-delete" ]; then echo 'delete failed' >&2; return 1; fi
  if [ "$operation" = -S ] && [ -z "$chain" ]; then
    for item in "$DIR/fw-$family-$table-"*; do
      [ -f "$item" ] || continue
      entry=${item##*/fw-$family-$table-}
      printf '%s\n' "-N $entry"
      sed "s/^/-A $entry /" "$item"
    done
    return 0
  fi
  case " $* " in *' -m addrtype '*) echo "Couldn't find match addrtype" >&2; return 1;; esac
  case " $* " in *' -m multiport '*) echo "Couldn't find match multiport" >&2; return 1;; esac
  if [ -f "$DIR/no-tproxy" ]; then
    case " $* " in *' -j TPROXY '*) echo 'TPROXY target unavailable' >&2; return 1;; esac
  fi
  if [ "$family" = 6 ] && [ -f "$DIR/fail-guard" ]; then
    case " $* " in *' -p udp --dport 9191 -j REJECT '*) echo 'listener guard rejected' >&2; return 1;; esac
  fi
  file="$DIR/fw-$family-$table-$chain"
  printf '%s %s %s %s %s\n' "$family" "$table" "$operation" "$chain" "$*" >> "$DIR/network.calls"
  if [ -f "$DIR/fail-switch" ] && [ "$operation $chain $*" = '-R UFI_MH_DNS 1 -j UFI_MH_DNS_B' ]; then
    rm "$DIR/fail-switch"
    return 1
  fi
  case "$operation" in
    -S) [ -f "$file" ] || return 1; printf '%s\n' "-N $chain"; sed "s/^/-A $chain /" "$file";;
    -N) [ ! -f "$file" ] || return 1; : > "$file";;
    -F) [ -f "$file" ] || return 1; : > "$file";;
    -X) [ -f "$file" ] || return 1; rm "$file";;
    -C) [ -f "$file" ] && grep -qxF -- "$*" "$file";;
    -A) [ -f "$file" ] || return 1; printf '%s\n' "$*" >> "$file";;
    -R) [ -s "$file" ] || return 1; shift; printf '%s\n' "$*" > "$file";;
    -I) [ -f "$file" ] || return 1; shift; { printf '%s\n' "$*"; cat "$file"; } > "$file.next"; mv "$file.next" "$file";;
    -D) [ -f "$file" ] || return 1; grep -vxF -- "$*" "$file" > "$file.next"; mv "$file.next" "$file";;
    *) return 1;;
  esac
}
ipt() { fake_iptables 4 "$@"; }
ip6t() { fake_iptables 6 "$@"; }
ip() {
  case "$*" in
    -N*) echo 'Option "-N" is unknown, try "ip -help".' >&2; return 1;;
    '-o -4 addr show')
      if [ -f "$DIR/local-addresses" ]; then cat "$DIR/local-addresses"; else echo '1: lo inet 127.0.0.1/8 scope host lo'; fi;;
    '-4 route show table 2026') cat "$DIR/routes";;
    '-4 route show table all') sed 's/$/ table 2026/' "$DIR/routes";;
    '-4 rule show') cat "$DIR/rules";;
    '-4 route add local 0.0.0.0/0 dev lo table 2026') echo 'local default dev lo scope host' > "$DIR/routes";;
    '-4 rule add priority 9000 fwmark 0x40000000/0x40000000 table 2026') echo '9000: from all fwmark 0x40000000/0x40000000 lookup 2026' > "$DIR/rules";;
    '-4 rule del priority 9000 fwmark 0x40000000/0x40000000 table 2026') [ -s "$DIR/rules" ] || return 1; : > "$DIR/rules";;
    '-4 route del local 0.0.0.0/0 dev lo table 2026') : > "$DIR/routes";;
    *) return 1;;
  esac
}
listeners_ready() { [ -f "$DIR/ready" ]; }
network_tools() { return 0; }

# Emulate the read-only native helper, leaving the production error/boolean handling intact.
CTL=fake_ctl
fake_ctl() {
  [ "$1" = network-state ] && [ "$3 $4 $5" = '2026 9000 0x40000000' ] || return 1
  [ ! -f "$DIR/fail-netlink" ] || { echo 'netlink permission denied'; return 1; }
  case "$2" in
    table-empty) if [ -s "$DIR/routes" ]; then echo false; else echo true; fi;;
    priority-free) if grep -q '^9000:' "$DIR/rules"; then echo false; else echo true; fi;;
    route-owned) if grep -q '^local default dev lo' "$DIR/routes"; then echo true; else echo false; fi;;
    rule-owned) if grep -q '^9000: from all fwmark 0x40000000/0x40000000 lookup 2026$' "$DIR/rules"; then echo true; else echo false; fi;;
    *) return 1;;
  esac
}
