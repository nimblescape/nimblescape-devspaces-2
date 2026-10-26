// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The command "Update All Images Now": the controller asks the question about the Monitor of the engine
// (monitorQuestion.ts), runs the step "Docker start" of Start, then sends the request to the Monitor of the Docker
// engine of the operation (the sidebar's) through the worker (`monitorRunNow`), with a progress until the monitor took
// the request, then the message; the window's call to the worker (workerMonitor.monitorRunNow) with the
// monitor settings of this computer, its time limit, and a strict answer; and the command and its menu in package.json.
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { BootstrapDocker } from '../core/docker/bootstrapDocker';
import { dockerTargetOf, type DockerTarget } from '../core/docker/dockerHost';
import { ensureDockerRunning } from '../core/docker/dockerStart';
import { UNREADABLE_DOCKER_TARGET, podmanDockerTarget } from '../core/docker/dockerTargets';
import { UserFacingError } from '../core/errors';
import { startDockerFor, type RemoteReachabilityDeps } from '../core/docker/remoteDocker';
import { OP_MONITOR_RUN_NOW } from '../core/helperChannel/protocol';
import { Actions, Messages, Steps } from '../core/messages';
import { MONITOR_ENSURE_FLOW_TIMEOUT_MS, MONITOR_RUN_NOW_FLOW_TIMEOUT_MS, type DockerStarter } from '../core/pipeline/operationBase';
import { abortError, silentLogger, type ProcessRunner, type RunResult } from '../core/ports';
import { Commands } from './commands';
import { Controller, type ControllerDeps } from './controller';
import { ControllerTexts } from './controllerTexts';
import { progressMessage, SHOW_LOG_COMMAND } from './progress';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';
import { workerMonitor, type TargetFlow } from './workerMonitor';

const REMOTE = { kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box', context: 'build-box' } as DockerTarget;
const LOCAL = { kind: 'local', host: '', endpoint: 'unix:///var/run/docker.sock' } as DockerTarget;
const IMAGES = { schedule: '7 6 * * *', timeZone: 'Europe/Vienna', permanent: true, computer: 'c'.repeat(32) };

beforeEach(() => {
  resetFakeVscode();
  // The progress runs its task at once (runWithProgress).
  fakeVscode.window.withProgress.mockImplementation(async (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) =>
    task({ report: () => {} }, { onCancellationRequested: () => ({ dispose: () => {} }) }),
  );
});
afterEach(() => vi.restoreAllMocks());

function controllerWith(
  target: DockerTarget,
  update?: ControllerDeps['updateImagesNow'],
  startDocker?: DockerStarter,
  monitorQuestion?: ControllerDeps['monitorQuestion'],
) {
  const infos: string[] = [];
  const logger = { info: vi.fn((text: string) => void infos.push(text)), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), show: vi.fn() };
  const deps = {
    logger,
    dockerTargets: { current: async () => target, resolve: async () => target, withOperation: <T>(fn: () => Promise<T>) => fn() },
    ...(update !== undefined ? { updateImagesNow: update } : {}),
    ...(startDocker !== undefined ? { startDocker } : {}),
    ...(monitorQuestion !== undefined ? { monitorQuestion } : {}),
  } as unknown as ControllerDeps;
  return { controller: new Controller(deps), infos };
}

/** Registers the commands of `controller`, and returns the handler of the command `id`. */
function registeredCommand(controller: Controller, id: string): (argument?: unknown) => Promise<void> {
  const commands = new Map<string, (argument?: unknown) => Promise<void>>();
  fakeVscode.commands.registerCommand.mockImplementation((command: string, handler: (argument?: unknown) => Promise<void>) => {
    commands.set(command, handler);
    return { dispose() {} };
  });
  controller.registerCommands();
  const handler = commands.get(id);
  if (handler === undefined) throw new Error(`The command ${id} is not registered.`);
  return handler;
}

/** Records in `events` the step that each message of the progress names (progressMessage), or 'no step'. */
function recordProgressSteps(events: string[]): void {
  fakeVscode.window.withProgress.mockImplementation(async (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) =>
    task(
      { report: (value: { message: string }) => void events.push(Object.values(Steps).find((text) => value.message.includes(`${text}.`)) ?? 'no step') },
      { onCancellationRequested: () => ({ dispose: () => {} }) },
    ),
  );
}

describe('the command Update All Images Now', () => {
  it('asks the Monitor of the engine of the operation, with a progress, then says that it updates now', async () => {
    const update = vi.fn(async (_target: DockerTarget, _signal: AbortSignal) => {});
    const { controller, infos } = controllerWith(REMOTE, update);
    await controller.updateImagesNow();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toBe(REMOTE);
    expect(update.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(fakeVscode.window.withProgress).toHaveBeenCalledTimes(1);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith('The Monitor on build-box updates the images now.');
    expect(infos).toContain('The Monitor on build-box took the request of "Update All Images Now".');
  });

  it('asks about the Monitor of the engine first (monitorQuestion.ts); a closed question goes on with the request', async () => {
    const order: string[] = [];
    const update = vi.fn(async () => void order.push('update'));
    const askIfNeeded = vi.fn(async (host: string) => {
      order.push(`ask ${host}`);
      return 'closed' as const;
    });
    await controllerWith(REMOTE, update, undefined, { askIfNeeded }).controller.updateImagesNow();
    expect(order).toEqual(['ask build-box', 'update']);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith('The Monitor on build-box updates the images now.');
  });

  it('names the local Docker for a local engine', async () => {
    const { controller } = controllerWith(LOCAL, async () => {});
    await controller.updateImagesNow();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith('The Monitor on the local Docker updates the images now.');
  });

  it('runs the step "Docker start" of Start in the progress, then names the next step and asks the Monitor', async () => {
    const events: string[] = [];
    recordProgressSteps(events);
    // A local Docker that does not run: the step starts it, and the progress says so.
    const startDocker = vi.fn<DockerStarter>(async ({ onStarting }) => {
      events.push('start');
      onStarting();
    });
    const update = vi.fn(async (_target: DockerTarget, _signal: AbortSignal) => void events.push('update'));
    const { controller } = controllerWith(LOCAL, update, startDocker);
    await controller.updateImagesNow();
    // The progress does not say "Starting Docker" while the worker starts and asks the Monitor.
    expect(events).toEqual(['no step', 'start', Steps.startingDocker, Steps.sendingRequest, 'update']);
    expect(startDocker.mock.calls[0][0].signal).toBe(update.mock.calls[0][1]);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith('The Monitor on the local Docker updates the images now.');
  });

  // The order of Start: the question about the Monitor, then in the progress the step "Docker start", then the request.
  // Each message of the progress ends with the link Show details (progress.ts), which opens the log and hides the
  // progress, which stays in the notification center with its Cancel button.
  it('asks the question about the Monitor before the Docker start and the request; each step has the link Show details', async () => {
    const order: string[] = [];
    const messages: string[] = [];
    fakeVscode.window.withProgress.mockImplementation(async (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) =>
      task({ report: (value: { message: string }) => void messages.push(value.message) }, { onCancellationRequested: () => ({ dispose: () => {} }) }),
    );
    const askIfNeeded = vi.fn(async (host: string) => {
      order.push(`ask ${host || 'the local Docker'}`);
      return 'keepRunning' as const;
    });
    const startDocker = vi.fn<DockerStarter>(async ({ onStarting }) => {
      order.push('start');
      onStarting();
    });
    const update = vi.fn(async (_target: DockerTarget, _signal: AbortSignal) => void order.push('update'));
    await controllerWith(LOCAL, update, startDocker, { askIfNeeded }).controller.updateImagesNow();
    expect(order).toEqual(['ask the local Docker', 'start', 'update']);
    const title = ControllerTexts.requestingImageUpdate('the local Docker');
    expect(messages).toEqual([
      progressMessage(title, undefined, undefined),
      progressMessage(title, 'startingDocker', undefined),
      progressMessage(title, 'sendingRequest', undefined),
    ]);
    for (const message of messages) {
      expect(message.endsWith(` [${Actions.showDetails}](command:${SHOW_LOG_COMMAND}?%5B%22progressNotification%22%5D)`), message).toBe(true);
    }
  });

  it('shows no step when Docker runs already', async () => {
    const events: string[] = [];
    recordProgressSteps(events);
    const startDocker = vi.fn<DockerStarter>(async () => void events.push('start'));
    const update = vi.fn(async (_target: DockerTarget, _signal: AbortSignal) => void events.push('update'));
    const { controller } = controllerWith(LOCAL, update, startDocker);
    await controller.updateImagesNow();
    expect(events).toEqual(['no step', 'start', 'update']);
  });

  it.each([
    ['rejects, as ensureDockerRunning does', (signal: AbortSignal) => new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(abortError())))],
    ['ends anyway, for example because Docker is ready at that moment', (signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))],
  ])('can be cancelled while Docker starts, without a Monitor call or a message (the start %s)', async (_name, starting) => {
    // As VS Code: only a cancellable progress has a Cancel button.
    let cancel: () => void = () => undefined;
    fakeVscode.window.withProgress.mockImplementation(
      async (options: { cancellable?: boolean }, task: (progress: unknown, token: unknown) => Promise<unknown>) =>
        task(
          { report: () => {} },
          {
            onCancellationRequested: (listener: () => void) => {
              if (options.cancellable) cancel = listener;
              return { dispose: () => {} };
            },
          },
        ),
    );
    const startDocker = vi.fn<DockerStarter>(async ({ onStarting, signal }) => {
      onStarting();
      if (signal) await starting(signal);
    });
    const update = vi.fn(async (_target: DockerTarget, _signal: AbortSignal) => {});
    const { controller, infos } = controllerWith(LOCAL, update, startDocker);
    const command = registeredCommand(controller, Commands.updateImagesNow)();
    await vi.waitFor(() => expect(startDocker).toHaveBeenCalledTimes(1));
    expect(fakeVscode.window.withProgress.mock.calls[0][0]).toMatchObject({ cancellable: true });
    cancel();
    await command;
    expect(update).not.toHaveBeenCalled();
    expect(fakeVscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(infos).toContain('The operation was cancelled.');
    expect(infos.some((text) => text.includes('took the request'))).toBe(false);
  });

  it('shows a failure with Try again, which runs the command again', async () => {
    // The first Docker start fails; after Try again, Docker starts and the Monitor is asked.
    const startDocker = vi
      .fn<DockerStarter>()
      .mockRejectedValueOnce(new UserFacingError('dockerStartFailed', Messages.dockerStartFailed, 'Docker was not ready after 120 seconds.'))
      .mockResolvedValue(undefined);
    const update = vi.fn(async (_target: DockerTarget, _signal: AbortSignal) => {});
    fakeVscode.window.showErrorMessage.mockResolvedValueOnce(Actions.tryAgain);
    const { controller } = controllerWith(LOCAL, update, startDocker);
    await registeredCommand(controller, Commands.updateImagesNow)();
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(Messages.dockerStartFailed, Actions.showDetails, Actions.tryAgain);
    await vi.waitFor(() => expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith('The Monitor on the local Docker updates the images now.'));
    expect(startDocker).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(1);
  });

  // The Docker CLI with the Docker-compatible API of Podman (for example with
  // DOCKER_HOST=unix:///run/user/1000/podman/podman.sock) is a local target: only the step "Docker start" finds Podman
  // (BootstrapDocker.podmanInUse).
  it('refuses a Podman engine behind the Docker CLI with the message of Start, without the Monitor', async () => {
    const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
    const answers: Record<string, RunResult> = {
      info: ok('"5.2.2"\n'),
      '--version': ok('Docker version 29.8.0, build 3f2a5b1\n'),
      version: ok(`${JSON.stringify({ Components: [{ Name: 'Podman Engine', Version: '5.2.2' }], Version: '5.2.2' })}\n`),
    };
    const runner: ProcessRunner = {
      run: async (_file, args) => {
        const answer = answers[args[0]];
        if (answer === undefined) throw new Error(`Unexpected call: docker ${args.join(' ')}`);
        return answer;
      },
    };
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux', { fileIdentity: async () => 'docker 29.8.0' });
    // The step of the operations (extension.ts); a local target needs no remote dependency.
    const startDocker: DockerStarter = async ({ onStarting, signal }) =>
      startDockerFor(
        LOCAL,
        () => ensureDockerRunning(docker, runner, silentLogger, { platform: 'linux', onStarting, signal }),
        { logger: silentLogger } as RemoteReachabilityDeps,
        signal,
      );
    const update = vi.fn(async (_target: DockerTarget, _signal: AbortSignal) => {});
    const { controller } = controllerWith(LOCAL, update, startDocker);
    await expect(controller.updateImagesNow()).rejects.toMatchObject({
      code: 'dockerEndpointUnsupported',
      message: Messages.podmanNotSupported,
      detail: 'docker version: the engine is Podman Engine 5.2.2.',
    });
    expect(update).not.toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('a failure rejects (the command shows it) and says nothing of an update', async () => {
    const { controller } = controllerWith(REMOTE, async () => Promise.reject(new Error('The Monitor did not take the request: Usage')));
    await expect(controller.updateImagesNow()).rejects.toThrow('did not take the request');
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['Podman', podmanDockerTarget('docker --version: podman version 5.2.2'), Messages.podmanNotSupported],
    ['a Docker context that cannot be read', UNREADABLE_DOCKER_TARGET, Messages.dockerContextUnreadable],
    ['an endpoint that is neither local nor SSH', dockerTargetOf('tcp://10.0.0.5:2375', 'tcp-box'), Messages.dockerEndpointUnsupported('tcp://10.0.0.5:2375')],
  ])('refuses %s with its message, without a progress and without the Monitor', async (_name, target, message) => {
    const update = vi.fn(async (_target: DockerTarget, _signal: AbortSignal) => {});
    // Refused before the question about the Monitor and before the step "Docker start", as Start is.
    const startDocker = vi.fn<DockerStarter>(async () => {});
    const askIfNeeded = vi.fn(async () => 'keepRunning' as const);
    const { controller } = controllerWith(target, update, startDocker, { askIfNeeded });
    await expect(controller.updateImagesNow()).rejects.toMatchObject({ code: 'dockerEndpointUnsupported', message });
    expect(update).not.toHaveBeenCalled();
    expect(askIfNeeded).not.toHaveBeenCalled();
    expect(startDocker).not.toHaveBeenCalled();
    expect(fakeVscode.window.withProgress).not.toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('does nothing without the call to the worker', async () => {
    const { controller } = controllerWith(REMOTE);
    await controller.updateImagesNow();
    expect(fakeVscode.window.withProgress).not.toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('is a command of package.json, in the Command Palette and in the "…" menu of the view', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { commands: Array<{ command: string; title: string; category: string }>; menus: Record<string, Array<{ command: string; when?: string; group?: string }>> };
    };
    expect(Commands.updateImagesNow).toBe('devspaces.updateImagesNow');
    expect(manifest.contributes.commands.find((entry) => entry.command === Commands.updateImagesNow)).toEqual({
      command: Commands.updateImagesNow,
      title: 'Update All Images Now',
      category: 'Devspaces',
    });
    // Not hidden in the Command Palette.
    expect(manifest.contributes.menus.commandPalette.some((entry) => entry.command === Commands.updateImagesNow)).toBe(false);
    expect(manifest.contributes.menus['view/title'].find((entry) => entry.command === Commands.updateImagesNow)).toEqual({
      command: Commands.updateImagesNow,
      when: 'view == devspaces.repositories',
      group: '2_maintenance@1',
    });
  });
});

describe('the call of the window to the worker (workerMonitor.monitorRunNow)', () => {
  function monitorWith(answer: () => unknown) {
    const calls: Parameters<TargetFlow>[] = [];
    const flow: TargetFlow = async (...args) => {
      calls.push(args);
      const value = answer();
      if (value instanceof Error) throw value;
      return value;
    };
    return { monitor: workerMonitor({ flow, owner: () => ({ windowId: 'window-1', pid: 7 }), logger: silentLogger }), calls };
  }

  it('sends the monitor settings of this computer to the worker of the engine, within its time limit, with the signal', async () => {
    const signal = new AbortController().signal;
    const { monitor, calls } = monitorWith(() => ({ requested: true }));
    await expect(monitor.monitorRunNow(REMOTE, IMAGES, signal)).resolves.toBeUndefined();
    expect(calls).toEqual([[OP_MONITOR_RUN_NOW, { images: IMAGES }, { target: REMOTE, timeoutMs: MONITOR_RUN_NOW_FLOW_TIMEOUT_MS, signal }]]);
    // The ensure of the monitor and one command in it.
    expect(MONITOR_RUN_NOW_FLOW_TIMEOUT_MS).toBeGreaterThan(MONITOR_ENSURE_FLOW_TIMEOUT_MS);
  });

  it('rejects a failure, an answer that is not exactly { requested: true }, and settings beyond the checks', async () => {
    await expect(monitorWith(() => new Error('docker exec failed')).monitor.monitorRunNow(REMOTE, IMAGES)).rejects.toThrow('docker exec failed');
    for (const answer of [{ requested: false }, { requested: true, extra: 1 }, {}, null, 'yes']) {
      await expect(monitorWith(() => answer).monitor.monitorRunNow(REMOTE, IMAGES), JSON.stringify(answer)).rejects.toThrow('invalid value');
    }
    const invalid = monitorWith(() => ({ requested: true }));
    await expect(invalid.monitor.monitorRunNow(REMOTE, { ...IMAGES, schedule: 'daily' })).rejects.toThrow('cannot be sent');
    expect(invalid.calls).toEqual([]);
  });
});
