import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  chmod,
  rm,
  readlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealRequest, taskID } from '../src/transport/ufi';
import {
  parseJob,
  parseState,
  type TaskAction,
  type TaskParams,
} from '../src/state';
import sodium from 'libsodium-wrappers';

const exec = promisify(execFile);

test('sealed browser intents run in a detached native worker; failed updates preserve config', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ufi-native-'));
  const root = join(folder, 'mihomoctl'),
    uploads = join(folder, 'uploads'),
    binary = join(folder, 'mihomoctl-installer');
  await mkdir(uploads);
  let source =
    'proxies: []\nrules: ["MATCH,DIRECT"]\nexternal-controller: 127.0.0.1:9999\n';
  let requested = 0;
  const addresses: string[] = [];
  const server = createServer(async (request, response) => {
    requested++;
    addresses.push(`http://${request.headers.host}${request.url}`);
    await delay(200);
    response.end(source);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await exec('go', ['build', '-o', binary, './cmd/mihomoctl'], {
      cwd: '..',
      env: { ...process.env, CGO_ENABLED: '0' },
      timeout: 45_000,
    });
    async function cli(command: string, ...args: string[]) {
      const { stdout } = await exec(
        binary,
        [
          '--platform',
          'ufi',
          '--root',
          root,
          command,
          ...(command === 'submit' ? ['--uploads', uploads] : []),
          ...args,
        ],
        { timeout: 10_000 },
      );
      return JSON.parse(stdout);
    }
    await cli('install', '--release-proxy', 'https://mirror.example.com/');
    const inspect = () =>
      cli('status').then((value) => parseState(JSON.stringify(value)));
    const initial = await inspect();
    expect(initial.service).toBe(true);
    expect(initial.settings.releaseProxy).toBe('https://mirror.example.com');
    expect(initial.publicKey).toHaveLength(44);
    const submit = async (action: TaskAction, params: TaskParams) => {
      const id = taskID();
      const { bytes, hash } = await sealRequest(initial.publicKey, {
        id,
        action,
        params,
      });
      expect(new TextDecoder().decode(bytes)).not.toContain(
        JSON.stringify(params),
      );
      const name = crypto.randomUUID() + '.bin';
      await writeFile(join(uploads, name), bytes);
      const job = parseJob(await cli('submit', name, hash));
      expect(job.id).toBe(id);
      // Submitter has exited. A fresh process can observe the durable task.
      for (let attempt = 0; attempt < 100; attempt++) {
        const observed = parseJob(await cli('job', id));
        if (!['queued', 'running'].includes(observed.state)) return observed;
        await delay(30);
      }
      throw new Error('Worker did not finish');
    };
    expect((await submit('save-release-proxy', { releaseProxy: 'https://forward.example.com/' })).state).toBe('succeeded');
    expect((await inspect()).settings.releaseProxy).toBe('https://forward.example.com');
    expect(
      (await submit('save-interfaces', { interfaces: 'wlan0' }))
        .state,
    ).toBe('succeeded');
    expect((await inspect()).settings.interfaces).toEqual(['wlan0']);
    expect((await inspect()).settings.releaseProxy).toBe('https://forward.example.com');
    const taskLog = await cli('log-read', 'tasks');
    expect(taskLog.text).toContain('action=save-interfaces');
    expect(taskLog.text).toContain('任务已完成');
    expect((await cli('log-read', 'tasks', taskLog.cursor)).text).toBe('');
    await writeFile(join(root, 'runtime/core.log'), 'secret: fixture-log-secret\nsafe core line\n');
    const coreLog = await cli('log-read', 'core');
    expect(coreLog.text).toContain('safe core line');
    expect(coreLog.text).not.toContain('fixture-log-secret');
    expect(coreLog.text).not.toContain('save-interfaces');
    await expect(cli('log-read', '../mihomoctl.db')).rejects.toThrow();
    await rm(join(root, 'runtime/tasks.log'));
    await mkdir(join(root, 'runtime/tasks.log'));
    expect((await submit('save-interfaces', { interfaces: 'wlan0' })).state).toBe('failed');
    await rm(join(root, 'runtime/tasks.log'), { recursive: true });
    expect((await submit('save-interfaces', { interfaces: 'wlan0' })).state).toBe('succeeded');
    // Fake only mihomo validation; real Go performs HTTP, YAML, storage and job lifecycle.
    await writeFile(
      join(root, 'runtime/mihomo'),
      '#!/bin/sh\nif [ "$1" = -v ]; then echo "Mihomo Meta v1.19.30 android arm64 with go1.26.7"; fi\nexit 0\n',
    );
    await chmod(join(root, 'runtime/mihomo'), 0o700);
    expect((await inspect()).coreVersion).toBe('v1.19.30');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/?token=fixture-secret`;
    const accepted = await submit('update', { url });
    expect(accepted.state).toBe('succeeded');
    expect(requested).toBe(1);
    const config = await readFile(
      join(root, 'runtime/current/config.yaml'),
      'utf8',
    );
    expect(config).toContain('tproxy-port: 7894');
    expect(config).toContain('MATCH,DIRECT');
    expect(config).toContain('external-controller: 0.0.0.0:9090');
    expect((await inspect()).controller?.applied).toBe(true);
    await sodium.ready;
    const keys = sodium.crypto_box_keypair();
    const encrypted = await cli(
      'controller-secret',
      sodium.to_base64(keys.publicKey, sodium.base64_variants.ORIGINAL),
    );
    const secret = sodium.to_string(
      sodium.crypto_box_seal_open(
        sodium.from_base64(encrypted, sodium.base64_variants.ORIGINAL),
        keys.publicKey,
        keys.privateKey,
      ),
    );
    expect(secret.length).toBe(64);
    expect(config).toContain(secret);
    expect(JSON.stringify(await inspect())).not.toContain(secret);
    expect(await cli('logs')).not.toContain(secret);
    expect(
      (
        await submit('save-controller', {
          controller: { enabled: true, port: 9191, secret: 'short' },
        })
      ).state,
    ).toBe('succeeded');
    expect((await inspect()).controller?.port).toBe(9191);
    const savedKey = await cli(
      'controller-secret',
      sodium.to_base64(keys.publicKey, sodium.base64_variants.ORIGINAL),
    );
    expect(
      sodium.to_string(
        sodium.crypto_box_seal_open(
          sodium.from_base64(savedKey, sodium.base64_variants.ORIGINAL),
          keys.publicKey,
          keys.privateKey,
        ),
      ),
    ).toBe('short');
    expect(requested).toBe(1); // Local settings apply from the saved source, not another subscription download.
    const current = await readlink(join(root, 'runtime/current'));
    source = '<html>subscription error</html>';
    const failed = await submit('update', { url: url + '&new=1' });
    expect(failed.state).toBe('failed');
    expect(failed.phase).toBe('adapt');
    expect(await readlink(join(root, 'runtime/current'))).toBe(current);
    expect(JSON.stringify(await inspect())).not.toContain('fixture-secret');
    expect(await cli('logs')).not.toContain('fixture-secret');
    source = 'proxies: []\nrules: ["MATCH,DIRECT"]\n';
    expect((await submit('update', {})).state).toBe('succeeded');
    expect(addresses.at(-1)).toBe(url);
    const localID = 'e'.repeat(32),
      localURL = url + '&from=local-cli';
    async function localTask(address: string) {
      const result = await new Promise<{ code: number; output: string }>(
        (resolve, reject) => {
          const child = execFile(
            binary,
            [
              '--root',
              root,
              'update',
              '--id',
              localID,
              '--input',
              '-',
            ],
            { timeout: 10_000 },
            (error, stdout) => {
              if (error && typeof error.code !== 'number') reject(error);
              else
                resolve({
                  code: error ? Number(error.code) : 0,
                  output: stdout,
                });
            },
          );
          child.stdin!.end(JSON.stringify({ url: address }));
        },
      );
      return { ...result, task: JSON.parse(result.output) };
    }
    const local = await localTask(localURL);
    expect(local.code).toBe(0);
    expect(local.task.state).toBe('succeeded');
    expect(local.output).not.toContain('fixture-secret');
    const count = requested;
    const replay = await localTask(localURL);
    expect(replay.code).toBe(0);
    expect(replay.task.id).toBe(localID);
    expect(requested).toBe(count);
    const conflict = await localTask(localURL + '&changed=1');
    expect(conflict.code).toBe(1);
    expect(conflict.output).toContain('任务 ID 冲突');
    expect(requested).toBe(count);
  } finally {
    const closed = promisify(server.close.bind(server))();
    server.closeAllConnections();
    await closed;
    await rm(folder, { recursive: true, force: true });
  }
}, 60_000);
