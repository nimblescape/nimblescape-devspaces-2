// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The probes of the mutation testing of the bridge fallback of openHelperChannel (a daemon without its default bridge
// network), and of the number of a worker name in use. No Docker: the processes of the channel are stand-ins.
import { describe, expect, it } from 'vitest';
import { dockerTargetOf, remoteContextNames, type DockerTarget } from '../docker/dockerHost';
import { silentLogger, type StartedProcess } from '../ports';
import { openHelperChannel } from './helperChannels';
import { CHANNEL_PROTOCOL_VERSION, encodeMessage, parseClientMessage } from './protocol';

const REMOTE: DockerTarget = dockerTargetOf('ssh://build-box', remoteContextNames('build-box')[0]);
const ENGINE = '"7b1c7a44-2f0e-4d38-9d1d-3a8f7b0e8c11" "/var/lib/docker"';
/** The same engine as the worker answers it (ProbeValue.engine: the values of `GET /info`). */
const ENGINE_IDENTITY = { id: '7b1c7a44-2f0e-4d38-9d1d-3a8f7b0e8c11', rootDir: '/var/lib/docker' };

/** A channel process that answers hello and the probe. */
function good(): StartedProcess {
  let stdout: ((text: string) => void) | undefined;
  return {
    write: (text) => {
      for (const line of text.split('\n').filter((part) => part !== '')) {
        const message = parseClientMessage(line);
        if (message?.t === 'hello') queueMicrotask(() => stdout?.(encodeMessage({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: 'v24', ops: ['docker', 'probe', 'sweep'] })));
        if (message?.t === 'op' && message.op === 'probe') {
          // The engine as its values.
          queueMicrotask(() => stdout?.(encodeMessage({ t: 'result', id: message.id, ok: true, value: { serverVersion: '27.1.0', detail: 'Docker 27.1.0', engine: ENGINE_IDENTITY } })));
        }
      }
      return true;
    },
    end: () => {},
    kill: () => {},
    onStdout: (listener) => (stdout = listener),
    onStderr: () => {},
    exited: new Promise(() => {}),
  };
}

/**
 * A `docker run` that the daemon refuses with `stderr` (exit code 125). `ended`: it ended before the extension wrote its
 * input (the write fails; its error output and its end come after it).
 */
function refused(stderr: string, options: { ended?: boolean } = {}): StartedProcess {
  let exit: (value: { exitCode: number | null }) => void = () => {};
  const exited = new Promise<{ exitCode: number | null }>((resolve) => (exit = resolve));
  return {
    write: () => options.ended !== true,
    end: () => {},
    kill: () => {},
    onStdout: () => {},
    onStderr: (listener) => {
      queueMicrotask(() => {
        listener(stderr);
        exit({ exitCode: 125 });
      });
    },
    exited,
  };
}

/**
 * Opens with the processes `first`, then a good one, for the window `api`; records the network and the name of each
 * start, the warnings, the information lines, the lists of containers (`ps`), and how often the names of the window and
 * of its devspace were read. `engine`: the containers that the list of the engine shows, or a list that fails, and the
 * devspace of the window.
 */
async function openWith(
  engine: { containers?: readonly string[]; listFails?: boolean; listFailsFrom?: number; listTimesOut?: boolean; devspace?: string | Error },
  ...first: Array<() => StartedProcess>
) {
  const networks: string[] = [];
  const names: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const lists: string[][] = [];
  let windowReads = 0;
  let devspaceReads = 0;
  const processes = [...first, good];
  const channel = await openHelperChannel(
    {
      start: (args) => {
        networks.push(args[args.indexOf('--network') + 1]);
        names.push(args[args.indexOf('--name') + 1]);
        return processes.shift()!();
      },
      runDirect: async (args) => {
        if (args[0] !== 'ps') return { exitCode: 0, stdout: `${ENGINE}\n`, stderr: '', timedOut: false };
        lists.push([...args]);
        if (engine.listFails || lists.length > (engine.listFailsFrom ?? Infinity)) return { exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon', timedOut: false };
        if (engine.listTimesOut) return { exitCode: null, stdout: '', stderr: '', timedOut: true };
        return { exitCode: 0, stdout: (engine.containers ?? []).map((name) => `${name}\n`).join(''), stderr: '', timedOut: false };
      },
      logger: { ...silentLogger, warn: (text) => warnings.push(text), info: (text) => infos.push(text) },
      script: async () => 'SCRIPT',
      helperTag: async () => 'devspaces-worker:abc',
      socketPath: async () => '/var/run/docker.sock',
      stateVolume: 'devspaces-monitor',
      vscodeVolume: 'devspaces-vscode',
      windowName: () => {
        windowReads++;
        return 'api';
      },
      devspaceName: async () => {
        devspaceReads++;
        if (engine.devspace instanceof Error) throw engine.devspace;
        return engine.devspace;
      },
    },
    REMOTE,
  ).catch((error: unknown) => {
    throw Object.assign(error as Error, { networks, names });
  });
  channel.close();
  return { networks, names, warnings, infos, lists, windowReads, devspaceReads };
}

/** openWith an engine whose list shows no container. */
async function open(...first: Array<() => StartedProcess>) {
  return openWith({}, ...first);
}

describe('the bridge fallback of openHelperChannel', () => {
  it('the refusal with the name in quotes or in other case starts again without network', async () => {
    for (const stderr of ['docker: Error response from daemon: network "bridge" not found.\n', 'docker: Error response from daemon: Network bridge not found.\n']) {
      const { networks } = await open(() => refused(stderr));
      expect(networks, stderr).toEqual(['bridge', 'none']);
    }
  });

  it('starts again without network also when the refused start ended before its input was written', async () => {
    const { networks } = await open(() => refused('docker: Error response from daemon: network "bridge" not found.\n', { ended: true }));
    expect(networks).toEqual(['bridge', 'none']);
  });

  it('another failure that names the bridge is not retried', async () => {
    await expect(open(() => refused('docker: Error response from daemon: failed to create endpoint on network bridge: address already in use.\n'))).rejects.toMatchObject({
      networks: ['bridge'],
    });
  });

  it('only a failure of the channel is retried: an error of the start itself with that text is not', async () => {
    await expect(
      open(() => {
        throw new Error('network bridge not found');
      }),
    ).rejects.toMatchObject({ message: 'network bridge not found', networks: ['bridge'] });
  });

  it('the start without network takes the number 1 again (the refused start created no container), and the warning names the engine', async () => {
    const { networks, names, warnings, lists } = await open(() => refused('docker: Error response from daemon: network bridge not found.\n'));
    expect(networks).toEqual(['bridge', 'none']);
    expect(names).toEqual(['devspaces-api-worker1', 'devspaces-api-worker1']);
    expect(lists).toEqual([]);
    expect(warnings.join('\n')).toContain('The Docker engine build-box has no default bridge network');
  });
});

describe('the number of a worker name in use', () => {
  const IN_USE =
    'docker: Error response from daemon: Conflict. The container name "/devspaces-api-worker1" is already in use by container "0123456789ab". You have to remove (or rename) that container to be able to reuse that name.\n';

  it('starts with 1, and lists the containers only when Docker refuses the name', async () => {
    const { names, lists } = await openWith({ containers: ['devspaces-api-worker1'] });
    expect(names).toEqual(['devspaces-api-worker1']);
    expect(lists).toEqual([]);
  });

  it('takes the lowest number that no container has, with the same network, and the log says why', async () => {
    const { networks, names, infos, lists } = await openWith({ containers: ['devspaces-api-worker1', 'devspaces-api-worker2', 'devspaces-web-worker3'] }, () => refused(IN_USE));
    expect(networks).toEqual(['bridge', 'bridge']);
    expect(names).toEqual(['devspaces-api-worker1', 'devspaces-api-worker3']);
    // One list without the worker, of the containers whose name contains the start of a worker name.
    expect(lists).toEqual([['ps', '--all', '--filter', 'name=devspaces-api-worker', '--format', '{{.Names}}']]);
    expect(infos.join('\n')).toContain('The worker name devspaces-api-worker1 is in use on build-box, so the worker starts as devspaces-api-worker3.');
    // A container with more than one name (legacy links) shows them in one line, separated by `,`.
    const linked = await openWith({ containers: ['devspaces-api-worker1', 'devspaces-api-worker2,other/api'] }, () => refused(IN_USE));
    expect(linked.names).toEqual(['devspaces-api-worker1', 'devspaces-api-worker3']);
  });

  // The Docker CLI can end before the extension writes the input of `docker run`: Docker's refusal of the name is only
  // in its error output, which comes after the failed write.
  it('takes the next number also when the refused start ended before its input was written', async () => {
    const { names, infos } = await openWith({ containers: ['devspaces-api-worker1'] }, () => refused(IN_USE, { ended: true }));
    expect(names).toEqual(['devspaces-api-worker1', 'devspaces-api-worker2']);
    expect(infos.join('\n')).toContain('The worker name devspaces-api-worker1 is in use on build-box, so the worker starts as devspaces-api-worker2.');
  });

  it('names the worker of a window of a devspace after it, apart from the containers of a service worker of Docker Compose', async () => {
    const devspace = 'devspaces-acme-api-tidy-berners';
    expect((await openWith({ devspace, containers: [`${devspace}-worker-1`, `${devspace}-app-1`] })).names).toEqual([`${devspace}-worker1`]);
    const { names, lists } = await openWith({ devspace, containers: [`${devspace}-worker1`, `${devspace}-worker-1`] }, () => refused(IN_USE));
    expect(names).toEqual([`${devspace}-worker1`, `${devspace}-worker2`]);
    expect(lists).toEqual([['ps', '--all', '--filter', `name=${devspace}-worker`, '--format', '{{.Names}}']]);
  });

  it('names the worker after the window when the devspace of the window cannot be found, and the log says why', async () => {
    const { names, warnings } = await openWith({ devspace: new Error('EISDIR: illegal operation on a directory') });
    expect(names).toEqual(['devspaces-api-worker1']);
    expect(warnings.join('\n')).toContain('The devspace of this window could not be found for the name of its worker (EISDIR: illegal operation on a directory)');
  });

  it('takes the next number when the list fails, and never a number that Docker refused', async () => {
    const failed = await openWith({ listFails: true }, () => refused(IN_USE));
    expect(failed.names).toEqual(['devspaces-api-worker1', 'devspaces-api-worker2']);
    expect(failed.infos.join('\n')).toContain('The containers on build-box could not be listed for the name of the worker (Cannot connect to the Docker daemon)');
    const late = await openWith({ listTimesOut: true }, () => refused(IN_USE));
    expect(late.names).toEqual(['devspaces-api-worker1', 'devspaces-api-worker2']);
    expect(late.infos.join('\n')).toContain('could not be listed for the name of the worker (no answer in time)');
    // A failed list after a good one keeps the good one.
    const later = await openWith({ containers: ['devspaces-api-worker1', 'devspaces-api-worker2'], listFailsFrom: 1 }, () => refused(IN_USE), () => refused(IN_USE));
    expect(later.names).toEqual(['devspaces-api-worker1', 'devspaces-api-worker3', 'devspaces-api-worker4']);
    // Another window took the free number between the list and the start.
    expect((await openWith({ containers: ['devspaces-api-worker1'] }, () => refused(IN_USE), () => refused(IN_USE))).names).toEqual([
      'devspaces-api-worker1',
      'devspaces-api-worker2',
      'devspaces-api-worker3',
    ]);
  });

  it('fails when Docker has refused 10 names, and says so', async () => {
    const refusals = Array.from({ length: 10 }, () => () => refused(IN_USE));
    const failure = open(...refusals);
    await expect(failure).rejects.toMatchObject({ names: Array.from({ length: 10 }, (_, index) => `devspaces-api-worker${index + 1}`) });
    await expect(failure).rejects.toThrow('Docker refused 10 names of the worker on build-box because other containers have them.');
  });

  it('the start without network keeps the numbers that Docker refused, and takes again a number refused for the network', async () => {
    const { networks, names, windowReads, devspaceReads } = await open(() => refused(IN_USE), () => refused('docker: Error response from daemon: network bridge not found.\n'), () => refused(IN_USE));
    expect(networks).toEqual(['bridge', 'bridge', 'none', 'none']);
    expect(names).toEqual(['devspaces-api-worker1', 'devspaces-api-worker2', 'devspaces-api-worker2', 'devspaces-api-worker3']);
    // The names of the window and of its devspace are read once for the open.
    expect(windowReads).toBe(1);
    expect(devspaceReads).toBe(1);
  });

  it('the start without network takes the number from the last list of the engine', async () => {
    const { networks, names, lists } = await openWith(
      { containers: ['devspaces-api-worker1', 'devspaces-api-worker2'] },
      () => refused(IN_USE),
      () => refused('docker: Error response from daemon: network bridge not found.\n'),
    );
    expect(networks).toEqual(['bridge', 'bridge', 'none']);
    expect(names).toEqual(['devspaces-api-worker1', 'devspaces-api-worker3', 'devspaces-api-worker3']);
    expect(lists).toHaveLength(1);
  });

  it('counts the refused names of both starts against the 10', async () => {
    const refusals = Array.from({ length: 9 }, () => () => refused(IN_USE));
    await expect(open(() => refused(IN_USE), () => refused('docker: Error response from daemon: network bridge not found.\n'), ...refusals)).rejects.toMatchObject({
      networks: ['bridge', 'bridge', ...Array.from({ length: 9 }, () => 'none')],
    });
  });

  it('another failure that is already in use is not retried', async () => {
    await expect(open(() => refused('docker: Error response from daemon: driver failed programming external connectivity: address already in use.\n'))).rejects.toMatchObject({
      networks: ['bridge'],
    });
  });
});
