import { createServer } from 'node:http';
import { once } from 'node:events';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dashboardURL, describeTask } from '../src/gateway';
import { afterEach, expect, vi, test } from 'vitest';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
  symlink,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { subscriptionURL, interfaces, releaseProxy, releaseURL, controllerSettings, withGeneratedSecret } from '../src/config';
import { quote, shellCommand, shellResult } from '../src/transport/ufi';
import {
  disabledReason,
  emptyState,
  lifecycleAction,
  parseState,
  componentVersion,
  topTask,
  parseJob,
} from '../src/state';
import { requestJSON } from '../src/request';
import { z } from 'zod';

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function networkFunctions() {
  const source = await readFile('../internal/platform/network_ufi.sh', 'utf8');
  return source.slice(source.indexOf('MARK='), source.indexOf('\ncase "$ACTION" in'));
}

test('input validation and shell results preserve the trust boundary', async () => {
  expect(interfaces('wlan0, rndis0 wlan0')).toBe('wlan0 rndis0');
  expect(interfaces('')).toBe('auto');
  expect(interfaces(' auto ')).toBe('auto');
  expect(interfaces('local0')).toBe('local0');
  for (const name of ['lo', 'rmnet_data0', 'wlan0;reboot', '-i'])
    expect(() => interfaces(name)).toThrow();
  expect(() => subscriptionURL('file:///etc/passwd')).toThrow();
  expect(() => subscriptionURL('https://example.com/\noutput=/bad')).toThrow();
  expect(subscriptionURL('https://example.com/?key=x')).toContain('key=x');
  for (const invalid of ['http://mirror.test', 'https://user:pass@mirror.test', 'https://mirror.test/path', 'https://mirror.test/?token=x', 'https://mirror.test/#', 'https://mirror.test/?', 'https://mirror.test/../', 'https://mirror.test\\evil'])
    expect(() => releaseProxy(invalid)).toThrow();
  expect(releaseProxy(' https://MIRROR.test/ ')).toBe('https://mirror.test');
  const upstream = 'https://github.com/o/r/releases/download/v1/a%2Fb?x=a+b&y=x%26y';
  const forwarded = new URL(releaseURL('https://mirror.test', upstream));
  expect(decodeURIComponent(forwarded.pathname.slice(1))).toBe(upstream);
  expect(forwarded.search).toBe('');
  expect(releaseURL('', upstream)).toBe(upstream);
  const value = "a'b ! \\! $(printf injected) `printf injected`\n中文";
  const proc = spawnSync(
    'sh',
    ['-c', shellCommand(`printf '%s' ${quote(value)}`, 'TEST_')],
    { encoding: 'utf8', timeout: 10_000 },
  );
  expect(shellResult(proc.stdout, 'TEST_')).toBe(value);
  expect(proc.status).toBe(0);
  expect(() => shellResult('bad\nTEST_2', 'TEST_')).toThrow('bad');
  expect(() => shellResult('looks successful', 'TEST_')).toThrow('完整响应');
});

test('network setup refuses foreign table and scopes interception to LAN', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mihomoctl-network-'));
  temporary.push(dir);
  await writeFile(join(dir, 'interfaces'), 'wlan0 rndis0\n');
  for (const name of [
    'routes',
    'rules',
    'ready',
    'fw-4-mangle-PREROUTING',
    'fw-4-nat-PREROUTING',
    'fw-4-filter-INPUT',
    'fw-6-filter-INPUT',
    'fw-6-filter-FORWARD',
  ]) {
    await writeFile(join(dir, name), '');
  }
  const network = await networkFunctions();
  const harness = await readFile('tests/fake-net.sh', 'utf8');
  const run = async () => {
    const script = `DIR=${quote(dir)}
${network}
${harness}
network_start`;
    const proc = spawnSync('sh', ['-c', script], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return {
      output: proc.stdout,
      code: proc.status,
    };
  };
  await writeFile(join(dir, 'routes'), 'foreign route');
  const collision = await run();
  expect(collision.code).toBe(1);
  expect(existsSync(join(dir, 'network.calls'))).toBe(false);
  await writeFile(join(dir, 'routes'), '');
  const ok = await run();
  expect(ok.code).toBe(0);
  const calls = await readFile(join(dir, 'network.calls'), 'utf8');
  expect(calls).toContain('-i wlan0 -p tcp ! --dport 53 -j TPROXY');
  expect(calls).toContain('-i rndis0 -p udp --dport 53 -j REDIRECT');
  expect(calls).toContain(
    '-i wlan0 -j REJECT --reject-with icmp6-adm-prohibited',
  );
  expect(calls).not.toContain('OUTPUT');
  expect(calls).not.toContain(' -F ');
  expect(await readFile(join(dir, 'network.active'), 'utf8')).toBe(
    'A\nwlan0 rndis0\n127.0.0.1\n',
  );
  await writeFile(join(dir, 'interfaces'), 'wlan0 rndis0 usb0\n');
  await writeFile(join(dir, 'fail-switch'), '');
  expect((await run()).code).toBe(1);
  expect(await readFile(join(dir, 'network.active'), 'utf8')).toBe(
    'A\nwlan0 rndis0\n127.0.0.1\n',
  );
  for (const name of [
    'fw-4-filter-UFI_MH_IN',
    'fw-6-filter-UFI_MH6',
    'fw-4-nat-UFI_MH_DNS',
    'fw-4-mangle-UFI_MH',
  ]) {
    expect(await readFile(join(dir, name), 'utf8')).toMatch(/_A\n$/);
  }
  expect(existsSync(join(dir, 'network.pending'))).toBe(false);
  expect((await run()).code).toBe(0);
  expect(await readFile(join(dir, 'network.active'), 'utf8')).toBe(
    'B\nwlan0 rndis0 usb0\n127.0.0.1\n',
  );
  await rm(join(dir, 'ready'));
  expect((await run()).code).toBe(1);
});

test.each([undefined, '7894,1053,7890,7891,7892,7893,9191'])('without multiport, startup and missing-LAN states protect all listeners (%s)', async (configuredPorts) => {
  const dir = await mkdtemp(join(tmpdir(), 'mihomoctl-guards-'));
  temporary.push(dir);
  if (configuredPorts) {
    await mkdir(join(dir, 'current'));
    await writeFile(join(dir, 'current/ports'), configuredPorts);
  }
  const ports = (configuredPorts || '7894,1053').split(',');
  for (const name of [
    'routes',
    'rules',
    'fw-4-mangle-PREROUTING',
    'fw-4-nat-PREROUTING',
    'fw-4-filter-INPUT',
    'fw-6-filter-INPUT',
    'fw-6-filter-FORWARD',
  ]) {
    await writeFile(join(dir, name), '');
  }
  const network = await networkFunctions();
  const harness = await readFile('tests/fake-net.sh', 'utf8');
  const run = async (action: string) => {
    const proc = spawnSync(
      'sh',
      ['-c', `DIR=${quote(dir)}\n${network}\n${harness}\n${action}`],
      { encoding: 'utf8', timeout: 10_000 },
    );
    const error = proc.stderr;
    expect(proc.status, error).toBe(0);
    expect(error).toBe('');
  };
  await run('ACTION=prepare network_start');
  for (const chain of ['fw-4-filter-UFI_MH_IN_A', 'fw-6-filter-UFI_MH_IN6_A']) {
    const rules = (await readFile(join(dir, chain), 'utf8')).trim().split('\n');
    expect(rules[0]).toBe('-i lo -j RETURN');
    expect(rules.some((rule) => rule.endsWith('-j ACCEPT'))).toBe(false);
    for (const proto of ['tcp', 'udp']) for (const port of ports)
      expect(rules).toContain(`-p ${proto} --dport ${port} -j REJECT`);
  }
  expect(
    await readFile(join(dir, 'fw-4-mangle-UFI_MH_A'), 'utf8'),
  ).not.toContain('TPROXY');
  await writeFile(join(dir, 'ready'), '');
  await writeFile(join(dir, 'interfaces'), 'wlan0');
  await run('network_sync');
  for (const chain of ['fw-4-filter-UFI_MH_IN_B', 'fw-6-filter-UFI_MH_IN6_B']) {
    const rules = (await readFile(join(dir, chain), 'utf8')).trim().split('\n');
    for (const proto of ['tcp', 'udp']) for (const port of ports) {
      const accept = rules.indexOf(`-i wlan0 -p ${proto} --dport ${port} -j ACCEPT`);
      const reject = rules.indexOf(`-p ${proto} --dport ${port} -j REJECT`);
      expect(accept).toBeGreaterThan(0);
      expect(reject).toBeGreaterThan(accept);
    }
  }
  await writeFile(join(dir, 'local-addresses'), '1: lo inet 127.0.0.1/8 scope host lo\n2: rmnet_data0 inet 203.0.113.9/32 scope global rmnet_data0\n');
  await run('network_sync');
  let localSlot = (await readFile(join(dir, 'network.active'), 'utf8')).split('\n')[0]!;
  expect(await readFile(join(dir, `fw-4-mangle-UFI_MH_${localSlot}`), 'utf8')).toContain('-d 203.0.113.9/32 -j RETURN');
  await writeFile(join(dir, 'local-addresses'), '1: lo inet 127.0.0.1/8 scope host lo\n2: rmnet_data0 inet 203.0.113.10/32 scope global rmnet_data0\n');
  await run('network_sync');
  localSlot = (await readFile(join(dir, 'network.active'), 'utf8')).split('\n')[0]!;
  const localRules = await readFile(join(dir, `fw-4-mangle-UFI_MH_${localSlot}`), 'utf8');
  expect(localRules).toContain('-d 203.0.113.10/32 -j RETURN');
  expect(localRules).not.toContain('203.0.113.9/32');
  expect(localRules).not.toContain('addrtype');
  await run('resolve_interfaces() { echo; }; network_sync');
  const slot = (await readFile(join(dir, 'network.active'), 'utf8')).split('\n')[0]!;
  const guard = await readFile(
    join(dir, `fw-4-filter-UFI_MH_IN_${slot}`),
    'utf8',
  );
  expect(guard).toContain('-j REJECT');
  expect(guard).not.toContain('-i wlan0');
  expect(
    await readFile(join(dir, `fw-4-mangle-UFI_MH_${slot}`), 'utf8'),
  ).not.toContain('TPROXY');
});

test('firewall probe uses unhooked rules and cleanup never treats failed reads as absence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mihomoctl-probe-'));
  temporary.push(dir);
  for (const name of ['routes', 'rules', 'ready', 'fw-4-mangle-PREROUTING', 'fw-4-nat-PREROUTING', 'fw-4-filter-INPUT', 'fw-6-filter-INPUT', 'fw-6-filter-FORWARD'])
    await writeFile(join(dir, name), '');
  await writeFile(join(dir, 'interfaces'), 'wlan0');
  await writeFile(join(dir, 'fw-4-filter-OTHER'), '-j RETURN\n');
  const source = await networkFunctions();
  const harness = await readFile('tests/fake-net.sh', 'utf8');
  const run = (action: string) => spawnSync('sh', ['-c', `DIR=${quote(dir)}\n${source}\n${harness}\n${action}`], { encoding: 'utf8', timeout: 10_000 });
  const unsupportedFlag = run('ip -N -4 rule show');
  expect(unsupportedFlag.status).toBe(1);
  expect(unsupportedFlag.stderr).toContain('Option "-N" is unknown');
  await writeFile(join(dir, 'fail-netlink'), '');
  const unreadable = run('network_check');
  expect(unreadable.status).toBe(1);
  expect(unreadable.stderr).toContain('netlink permission denied');
  expect(existsSync(join(dir, 'network.owned'))).toBe(false);
  await rm(join(dir, 'fail-netlink'));
  await writeFile(join(dir, 'no-tproxy'), '');
  const unsupported = run('network_check');
  expect(unsupported.status).toBe(1);
  expect(unsupported.stderr).toContain('TPROXY target unavailable');
  expect(existsSync(join(dir, 'network.owned'))).toBe(false);
  expect(await readFile(join(dir, 'fw-4-mangle-PREROUTING'), 'utf8')).toBe('');
  await rm(join(dir, 'no-tproxy'));
  await mkdir(join(dir, 'current'));
  for (const invalid of [',,,', ',7894', '7894,', '7894,,1053']) {
    await writeFile(join(dir, 'current/ports'), invalid);
    const rejected = run('network_check');
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('监听保护端口列表无效');
    expect(existsSync(join(dir, 'network.owned'))).toBe(false);
  }
  await writeFile(join(dir, 'current/ports'), '7894,1053,9191');
  await writeFile(join(dir, 'fail-guard'), '');
  const failedGuard = run('network_check');
  expect(failedGuard.status).toBe(1);
  expect(failedGuard.stderr).toContain('listener guard rejected');
  expect(existsSync(join(dir, 'network.owned'))).toBe(false);
  expect(await readFile(join(dir, 'fw-4-mangle-PREROUTING'), 'utf8')).toBe('');
  await rm(join(dir, 'fail-guard'));
  expect(run('network_check').status).toBe(0);
  const calls = await readFile(join(dir, 'network.calls'), 'utf8');
  expect(calls).toContain('-p tcp ! --dport 53 -j TPROXY');
  expect(calls).toContain('-p udp ! --dport 53 -j TPROXY');
  expect(calls).toContain('-p tcp --dport 53 -j REDIRECT');
  expect(calls).not.toContain(' -I ');
  expect(existsSync(join(dir, 'network.active'))).toBe(false);

  expect(run('network_start').status).toBe(0);
  await writeFile(join(dir, 'fail-netlink'), '');
  expect(run('network_stop').status).toBe(1);
  expect(existsSync(join(dir, 'network.owned'))).toBe(true);
  await rm(join(dir, 'fail-netlink'));
  expect(run('network_start').status).toBe(0);
  await writeFile(join(dir, 'fail-query'), '');
  const failedRead = run('network_stop');
  expect(failedRead.status).toBe(1);
  expect(failedRead.stderr).toContain('permission denied');
  expect(existsSync(join(dir, 'network.owned'))).toBe(true);
  expect(existsSync(join(dir, 'network.active'))).toBe(true);
  await rm(join(dir, 'fail-query'));
  await writeFile(join(dir, 'fail-delete'), '');
  expect(run('network_stop').status).toBe(1);
  expect(existsSync(join(dir, 'network.owned'))).toBe(true);
  await rm(join(dir, 'fail-delete'));
  expect(run('network_stop').status).toBe(0);
  expect(existsSync(join(dir, 'network.owned'))).toBe(false);
  expect(await readFile(join(dir, 'fw-4-filter-OTHER'), 'utf8')).toBe('-j RETURN\n');
});

test('built plugin is one classic script with HTML-safe boundaries', async () => {
  const output = await readFile('dist/mihomoctl-ufi.js', 'utf8');
  expect(output.startsWith('//<script>')).toBe(true);
  expect(output.trimEnd().endsWith('//</script>')).toBe(true);
  expect(output.match(/<\/script\s*>/gi)?.length).toBe(1);
  expect(output.length).toBeLessThan(5 * 1024 * 1024);
  expect(await readdir('dist')).toEqual(['mihomoctl-ufi.js']);
  expect(output).not.toContain('mockDeviceState');
  for (const unused of ['sms_forward_mail', 'one_click_shell', 'delete_all_uploads_data'])
    expect(output).not.toContain(unused);
  expect(output).not.toContain('react_dom_client');
  expect(() => new Function(output)).not.toThrow();
});

test('auto LAN selection excludes cellular, VPN, upstream Wi-Fi and inactive links', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mihomoctl-auto-'));
  temporary.push(dir);
  const source = await networkFunctions();
  const addresses = `1: lo inet 127.0.0.1/8 scope host lo
2: rmnet_data0 inet 10.20.30.40/24 scope global rmnet_data0
3: wlan0 inet 192.168.0.1/24 scope global wlan0
4: rndis0 inet 192.168.42.1/24 scope global rndis0
5: wlan1 inet 192.168.1.8/24 scope global wlan1
6: tun0 inet 10.0.0.1/24 scope global tun0
7: br-lan@eth0 inet 172.16.0.1/24 scope global br-lan
8: ap1 inet 203.0.113.1/24 scope global ap1`;
  const run = async (routes: string, addr = addresses, failure = false) => {
    const script = `DIR=${quote(dir)}\n${source}
ip() {
  case "$*" in
    '-4 route show table all') ${failure ? 'return 1' : `printf '%s\\n' ${quote(routes)}`};;
    '-6 route show table all') echo 'default via fe80::1 dev wlan1 table 1010';;
    '-o -4 addr show up scope global') printf '%s\\n' ${quote(addr)};;
    *) return 1;;
  esac
}
resolve_interfaces`;
    const proc = spawnSync('sh', ['-c', script], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    const error = proc.stderr;
    expect(error).toBe('');
    return {
      value: proc.stdout.trim(),
      code: proc.status,
    };
  };
  expect((await run('default dev rmnet_data0 table 1009')).value).toBe(
    'br-lan rndis0 wlan0',
  );
  expect((await run('default dev wlan0 table 1011')).value).toBe(
    'br-lan rndis0',
  );
  expect((await run('', '')).value).toBe('');
  expect((await run('', addresses, true)).code).toBe(1);
  await writeFile(join(dir, 'interfaces'), 'custom0\n');
  expect((await run('')).value).toBe('custom0');
});

test('network refresh tracks LAN changes and waits without restarting core', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mihomoctl-sync-'));
  temporary.push(dir);
  const source = await networkFunctions();
  const script = `DIR=${quote(dir)}\n${source}
resolve_interfaces() { printf '%s' "$desired"; }
local_ipv4() { echo 127.0.0.1; }
active_addresses() { echo 127.0.0.1; }
listeners_ready() { return 0; }
active_interfaces() { cat "$DIR/interfaces.active" 2>/dev/null; }
network_ok() { return 0; }
network_stop() { echo stop; rm -f "$DIR/interfaces.active"; }
pause_capture() { echo pause; }
network_start() { echo "start:$desired"; printf '%s' "$desired" > "$DIR/interfaces.active"; }
desired=wlan0; network_sync
network_sync
desired='rndis0 wlan0'; network_sync
desired=''; network_sync
desired=wlan0; network_sync`;
  const proc = spawnSync('sh', ['-c', script], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(proc.stdout).toBe(
    'start:wlan0\nstart:rndis0 wlan0\npause\nstart:\nstart:wlan0\n',
  );
  expect(proc.status).toBe(0);
});

test('listener readiness requires all four core-owned sockets, not foreign listeners', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mihomoctl-listeners-'));
  temporary.push(dir);
  const procdir = join(dir, 'proc');
  await mkdir(join(procdir, '123/fd'), { recursive: true });
  await mkdir(join(procdir, 'net'));
  await writeFile(join(dir, 'core.pid'), '123');
  for (const inode of [11, 12, 13, 14])
    await symlink(`socket:[${inode}]`, join(procdir, `123/fd/${inode}`));
  const row = (port: string, state: string, inode: number) =>
    `0: 00000000:${port} 00000000:0000 ${state} 0 0 0 0 0 ${inode}\n`;
  await writeFile(
    join(procdir, 'net/tcp'),
    row('1ED6', '0A', 11) + row('041D', '0A', 12),
  );
  await writeFile(
    join(procdir, 'net/udp'),
    row('1ED6', '07', 13) + row('041D', '07', 14),
  );
  await writeFile(join(procdir, 'net/tcp6'), '');
  await writeFile(join(procdir, 'net/udp6'), '');
  const source = (await networkFunctions()).replaceAll('/proc/', `${procdir}/`);
  const run = async () => {
    const proc = spawnSync(
      'sh',
      [
        '-c',
        `DIR=${quote(dir)}\n${source}\nalive() { return 0; }\nlisteners_ready`,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    return proc.status;
  };
  expect(await run()).toBe(0);
  await mkdir(join(dir, 'current'));
  await writeFile(join(dir, 'current/api-port'), '9090');
  expect(await run()).toBe(1);
  await symlink('socket:[15]', join(procdir, '123/fd/15'));
  await writeFile(
    join(procdir, 'net/tcp'),
    row('1ED6', '0A', 11) + row('041D', '0A', 12) + row('2382', '0A', 15),
  );
  expect(await run()).toBe(0);
  await writeFile(
    join(procdir, 'net/udp'),
    row('1ED6', '07', 13) + row('041D', '07', 999),
  );
  expect(await run()).toBe(1);
  await writeFile(join(procdir, 'net/udp'), row('1ED6', '07', 13));
  expect(await run()).toBe(1);
});

test('UI gates actions by real prerequisites and keeps recovery actions accessible', () => {
  expect(disabledReason('install', null)).not.toBe('');
  expect(disabledReason('refresh', null)).toBe('');
  expect(disabledReason('install', emptyState)).toBe('');
  expect(disabledReason('uninstall', emptyState)).not.toBe('');
  const installed = {
    ...emptyState,
    agent: true,
    service: true,
    controller: { enabled: true, port: 9090, applied: false, overrides: true },
  };
  expect(lifecycleAction(null)).toBe('uninstall');
  expect(lifecycleAction(emptyState)).toBe('install');
  expect(lifecycleAction(installed)).toBe('uninstall');
  expect(disabledReason('install', installed)).toContain('已安装');
  expect(disabledReason('self-update', installed)).toBe('');
  expect(disabledReason('self-update', { ...installed, capture: true })).toContain('清理');
  expect(disabledReason('uninstall', null)).toBe('');
  expect(disabledReason('uninstall', installed, true)).not.toBe('');
  for (const action of ['start', 'restart', 'update', 'boot-on'] as const)
    expect(disabledReason(action, installed)).not.toBe('');
  expect(disabledReason('download', installed)).toBe('');
  expect(
    disabledReason('save-interfaces', { ...installed, running: true }),
  ).toContain('停止');
  const ready = { ...installed, core: true, config: true, subscription: true };
  expect(disabledReason('start', ready)).toBe('');
  expect(disabledReason('update', ready, false, 'https://new.example')).toBe(
    '',
  );
  expect(
    disabledReason('update', { ...ready, subscription: false }, false, ''),
  ).toContain('订阅');
  expect(disabledReason('update', ready, false, '')).toBe('');
  expect(disabledReason('start', { ...ready, running: true })).not.toBe('');
  expect(disabledReason('download', { ...ready, running: true })).not.toBe('');
  expect(disabledReason('stop', { ...ready, running: true })).toBe('');
  expect(disabledReason('boot-off', { ...installed, boot: true })).toBe('');
  expect(disabledReason('uninstall', { ...ready, locked: true })).not.toBe('');
  expect(disabledReason('logs', { ...ready, locked: true })).toBe('');
  expect(() => parseState('{"service":true}')).toThrow();
  expect(parseState(JSON.stringify(ready))).toEqual(ready);
  expect(() => parseState(JSON.stringify({ ...ready, protocol: ready.protocol - 1 }))).toThrow('协议不匹配');
  for (const field of ['coreVersion', 'controller', 'dashboard'] as const) {
    const incomplete = { ...ready } as Partial<typeof ready>;
    delete incomplete[field];
    expect(() => parseState(JSON.stringify(incomplete))).toThrow('协议不匹配');
  }
  expect(() => parseState(JSON.stringify({ ...ready, controller: null }))).toThrow('协议不匹配');
  expect(disabledReason('self-update', null)).not.toBe('');
  expect(disabledReason('stop', null)).toBe('');
  expect(lifecycleAction({ ...emptyState, agent: true })).toBe('uninstall');
  expect(disabledReason('uninstall', { ...emptyState, agent: true })).toBe('');
  expect(disabledReason('open-dashboard', ready)).toContain('安装面板');
  const panel = {
    ...ready,
    controller: { enabled: true, port: 9090, applied: true, overrides: true },
    dashboard: { installed: true, ready: true, version: 'v1.0.0' },
  };
  expect(disabledReason('open-dashboard', panel)).toContain('启动');
  expect(
    disabledReason('open-dashboard', {
      ...panel,
      running: true,
      listeners: true,
    }),
  ).toBe('');
  expect(
    dashboardURL(
      'https://user:pass@192.168.0.1:8080/api?token=private#x',
      9090,
      'key &#+%?中文',
    ),
  ).toBe('http://192.168.0.1:9090/ui/?hostname=192.168.0.1&port=9090&secret=key+%26%23%2B%25%3F%E4%B8%AD%E6%96%87#/setup');
  expect(() => dashboardURL('http://192.168.0.1/', 0, 'key')).toThrow();
});

test('request errors identify network, timeout, HTTP and malformed response stages', async () => {
  const context = {
    step: '查询最新版本',
    target: '管理浏览器 GET https://api.github.com/releases/latest',
    hint: '检查网络是否可以访问 GitHub API',
  };
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const error = await requestJSON(
      'https://api.github.com/releases/latest',
      {},
      context,
      z.unknown(),
    ).catch((error) => error as Error);
    if (!(error instanceof Error))
      throw new Error('Expected a request failure');
    expect(error.message).toContain('查询最新版本失败');
    expect(error.message).toContain('api.github.com');
    expect(error.message).toContain('TypeError: Failed to fetch');
    expect(error.message).toContain('检查网络是否可以访问 GitHub API');
    fetch.mockRejectedValueOnce(new TypeError('input.startsWith is not a function'));
    const callError = await requestJSON(
      'https://api.github.com/releases/latest', {}, context, z.unknown(),
    ).catch((error) => error as Error);
    if (!(callError instanceof Error)) throw new Error('Expected a request failure');
    expect(callError.message).toContain('JavaScript');
    expect(callError.message).not.toContain('DNS');
    fetch.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    await expect(
      requestJSON(
        'https://api.github.com/releases/latest',
        {},
        context,
        z.unknown(),
      ),
    ).rejects.toThrow('请求超时');
    fetch.mockResolvedValueOnce(
      new Response('{}', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' },
      }),
    );
    await expect(
      requestJSON(
        'https://api.github.com/releases/latest',
        {},
        context,
        z.unknown(),
      ),
    ).rejects.toThrow('HTTP 403（请求已被限流');
    fetch.mockResolvedValueOnce(new Response('<html>login</html>'));
    await expect(
      requestJSON(
        'https://api.github.com/releases/latest',
        {},
        context,
        z.unknown(),
      ),
    ).rejects.toThrow('响应不是有效 JSON');
    fetch.mockResolvedValueOnce(Response.json({ url: 7 }));
    await expect(
      requestJSON(
        'https://api.github.com/releases/latest',
        {},
        context,
        z.object({ url: z.string() }),
      ),
    ).rejects.toThrow('响应内容不符合预期格式');
    fetch.mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(
      requestJSON(
        'http://192.168.0.1/api/upload_img',
        {},
        {
          step: '上传到设备',
          target: 'UFI /api/upload_img',
          hint: '重新登录 UFI',
        },
        z.unknown(),
      ),
    ).rejects.toThrow('认证失败');
  } finally {
    fetch.mockRestore();
  }
});

test('UFI uploads preserve FormData and never retry failed requests', async () => {
  const context = {
    step: '上传到设备',
    target: 'UFI /api/upload_img',
    hint: '检查连接',
  };
  const body = new FormData();
  body.append('file', new File(['encrypted-fixture'], 'request.bin'));
  let requests = 0,
    uploaded = '';
  let method: string | undefined;
  let contentType = '';
  const server = createServer(async (incoming, response) => {
    requests++;
    method = incoming.method;
    contentType = incoming.headers['content-type'] || '';
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const form = await new Response(new Uint8Array(Buffer.concat(chunks)), {
      headers: { 'content-type': contentType },
    }).formData();
    uploaded = await (form.get('file') as File).text();
    response.writeHead(503).end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    await expect(
      requestJSON(address, { method: 'POST', body }, context, z.unknown()),
    ).rejects.toThrow('HTTP 503');
    expect(requests).toBe(1);
    expect(uploaded).toBe('encrypted-fixture');
    expect(method).toBe('POST');
    expect(contentType).toContain('multipart/form-data; boundary=');
  } finally {
    await promisify(server.close.bind(server))();
  }
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    fetch.mockImplementationOnce(async (input) => {
      // Fail after serialization, so Node's multipart encoder can finish cleanly.
      await (input as Request).arrayBuffer();
      throw new TypeError('Failed to fetch');
    });
    await expect(
      requestJSON(
        'http://192.168.0.1/api/upload_img',
        { method: 'POST', body },
        context,
        z.unknown(),
      ),
    ).rejects.toThrow('Failed to fetch');
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    fetch.mockRestore();
  }
});

test('component versions and task placement stay consistent', () => {
  expect(componentVersion(true, 'v1.19.30')).toBe('v1.19.30');
  expect(componentVersion(true, '')).toBe('版本未知');
  expect(componentVersion(false, 'v1.19.30')).toBe('未安装');
  expect(componentVersion(undefined, '')).toBe('状态未知');
  const job = parseJob({
    id: 'a'.repeat(32),
    action: 'download',
    state: 'succeeded',
    phase: 'done',
    updated: '',
    hash: '', started: new Date().toISOString(), downloaded: 0, total: 0, speed: 0, cancellable: false, cancelRequested: false,
  });
  expect(topTask(job)).toBe(false);
  const locked = { ...emptyState, agent: true, service: true, running: true, listeners: true, locked: true, task: job, controller: { enabled: true, port: 9090, applied: true, overrides: true }, dashboard: { installed: true, ready: true, version: 'test' } };
  expect(disabledReason('stop', locked)).toContain('控制锁尚未释放');
  expect(disabledReason('stop', { ...locked, task: { ...job, action: 'start', state: 'running' } })).toContain('查看任务进度');
  expect(disabledReason('open-dashboard', locked)).toBe('');
  expect(disabledReason('stop', { ...locked, locked: false })).toBe('');
  const timed = describeTask({ ...job, started: '2026-09-15T07:51:08Z', updated: '2026-09-15T08:03:08Z', state: 'failed' });
  expect(timed).toContain('开始时间：');
  expect(timed).toContain('结束时间：');
  expect(timed).toContain('耗时：720 秒');
  expect(topTask({ ...job, state: 'running' })).toBe(true);
  expect(topTask({ ...job, state: 'failed' })).toBe(true);
  expect(topTask({ ...job, action: 'update', state: 'running' })).toBe(true);
  expect(topTask({ ...job, action: 'update' })).toBe(false);
  expect(lifecycleAction({ ...emptyState, agent: true })).toBe('uninstall');
  expect(disabledReason('uninstall', { ...emptyState, agent: true })).toBe('');
});


test('override YAML accepts future fields but rejects malformed documents', () => {
  for (const yaml of ['', '{}', 'mode: global\nlog-level: debug\n', 'future-option: [one, two]\ndns: { enhanced-mode: fake-ip }', 'external-controller: "0.0.0.0:9191"\nsecret: "abc#123"'])
    expect(controllerSettings(yaml)).toEqual({ yaml });
  for (const yaml of ['[1, 2]', 'key: 1\nkey: 2', 'key: 1\n---\nkey: 2', 'secret: [', 'x'.repeat(21 * 1024)])
    expect(() => controllerSettings(yaml)).toThrow();
  const generated = withGeneratedSecret('mode: rule\n');
  expect(generated).toContain('mode: rule');
  expect(generated).toMatch(/secret: [a-f0-9]{64}/);
});
