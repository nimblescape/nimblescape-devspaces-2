// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker of the pipeline over the port of the worker's engine answers as the Docker CLI answers.
import { describe, expect, it } from 'vitest';
import { SECRET_REGISTRY, SECRET_TOKEN } from '../helperChannel/protocol';
import { LABEL_COMPOSE_SERVICE, LABEL_DEVSPACE_ID } from '../names';
import { silentLogger, type Logger } from '../ports';
import { EngineError, type DockerEngine, type EngineContainer, type EngineImage } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { EngineDocker, type PullLogins } from './engineDocker';
import { credentialServerName } from '../imageCheck/reference';
import { engineHijack } from '../../helperChannel/engineApi';
import { dockerEngine } from '../../helperChannel/engineClient';

const ENV = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const NAME = 'devspaces-acme-api-brave-noether';

function container(overrides: Partial<EngineContainer> = {}): EngineContainer {
  return { id: 'a'.repeat(64), name: NAME, state: 'running', rawState: 'running', labels: { [LABEL_DEVSPACE_ID]: ENV }, image: `${NAME}:1`, created: '2026-10-03T10:00:00Z', ...overrides };
}

function recording(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: { ...silentLogger, info: (text) => lines.push(`info ${text}`), warn: (text) => lines.push(`warn ${text}`) }, lines };
}

describe('the Docker of the pipeline over the port', () => {
  it('findContainer: the dev container of the devspace, the named one first, else running, else newest; warns about several', async () => {
    const service = container({ id: 's'.repeat(64), name: `${NAME}-db-1`, labels: { [LABEL_DEVSPACE_ID]: ENV, [LABEL_COMPOSE_SERVICE]: 'db' } });
    const old = container({ id: 'o'.repeat(64), name: 'old', state: 'stopped', rawState: 'exited', created: '2026-10-03T09:00:00Z' });
    const newer = container({ id: 'n'.repeat(64), name: 'newer', state: 'stopped', rawState: 'exited', created: '2026-10-03T11:00:00Z' });
    const named = container();
    const labels: string[] = [];
    let listed = [service, old, newer, named];
    const engine: DockerEngine = { ...unusedEngine(), containers: async (label) => (labels.push(label), listed) };
    const { logger, lines } = recording();
    const docker = new EngineDocker(engine, logger);
    expect((await docker.findContainer(ENV, NAME))?.id).toBe(named.id);
    expect(labels).toEqual([`${LABEL_DEVSPACE_ID}=${ENV}`]);
    expect(lines).toEqual([`warn 3 containers have the label ${LABEL_DEVSPACE_ID}=${ENV}: old, newer, ${NAME}`]);
    listed = [old, newer];
    expect((await docker.findContainer(ENV, NAME))?.id).toBe(newer.id);
    listed = [old, container({ id: 'r'.repeat(64), name: 'running', created: '2026-10-01T00:00:00Z' }), newer];
    expect((await docker.findContainer(ENV, NAME))?.id).toBe('r'.repeat(64));
    listed = [service];
    expect(await docker.findContainer(ENV, NAME)).toBeUndefined();
    // The public shape: without the time of the create.
    listed = [named];
    expect(await docker.findContainer(ENV, NAME)).not.toHaveProperty('created');
  });

  it('findContainer takes the newest by the time of the create, never by its text, and logs one that is not the named one', async () => {
    // Half a second later than `text`, which sorts after it as text (the engine trims the zeros of a fraction).
    const later = container({ id: 'l'.repeat(64), name: 'later', state: 'stopped', rawState: 'exited', created: '2026-10-08T09:00:00.5Z' });
    const text = container({ id: 't'.repeat(64), name: 'text', state: 'stopped', rawState: 'exited', created: '2026-10-08T09:00:00Z' });
    let listed = [text, later];
    const engine: DockerEngine = { ...unusedEngine(), containers: async () => listed };
    const { logger, lines } = recording();
    const docker = new EngineDocker(engine, logger);
    expect((await docker.findContainer(ENV, NAME))?.id).toBe(later.id);
    expect(lines).toContain(`info There is no container ${NAME}; the container later of the devspace is used.`);
    // The named one whatever its state, also while another runs; then nothing but the warning about several.
    listed = [container({ id: 'r'.repeat(64), name: 'running', created: '2026-10-08T10:00:00Z' }), container({ state: 'stopped', rawState: 'exited' })];
    lines.length = 0;
    expect((await docker.findContainer(ENV, NAME))?.id).toBe('a'.repeat(64));
    expect(lines).toEqual([`warn 2 containers have the label ${LABEL_DEVSPACE_ID}=${ENV}: running, ${NAME}`]);
  });

  it('devspaceContainers lists one devspace by its label, with the times of the create, within the time limit', async () => {
    const asked: Array<{ label: string; signal?: AbortSignal }> = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      containers: async (label, signal) => (asked.push({ label, signal }), [container({ exitCode: 0, restartCount: 1 }), container({ id: 'b'.repeat(64), name: 'other', created: undefined })]),
    };
    const listed = await new EngineDocker(engine).devspaceContainers(ENV);
    expect(asked).toHaveLength(1);
    expect(asked[0].label).toBe(`${LABEL_DEVSPACE_ID}=${ENV}`);
    // A request with a time limit (as every request of EngineDocker).
    expect(asked[0].signal).toBeInstanceOf(AbortSignal);
    expect(listed.map((each) => each.created)).toEqual(['2026-10-03T10:00:00Z', undefined]);
    expect(listed[0]).not.toHaveProperty('exitCode');
    expect(listed[0]).not.toHaveProperty('restartCount');
    expect(listed[1]).not.toHaveProperty('created');
  });

  // The read of a container's state ends with the abort of its caller, so that a cancelled open does not wait up to
  // DOCKER_QUERY_TIMEOUT_MS for an engine that hangs.
  it('containerState passes the abort of its caller to the engine', async () => {
    const seen: AbortSignal[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      container: (_reference, signal) =>
        new Promise((_resolve, reject) => {
          if (signal) seen.push(signal);
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    };
    const controller = new AbortController();
    const state = new EngineDocker(engine).containerState('c', controller.signal);
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    expect(seen[0].aborted).toBe(false);
    controller.abort();
    await expect(state).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen[0].aborted).toBe(true);
  });

  it('containerState, imageExists, imageId, volumeExists: missing is an answer, not a failure', async () => {
    const engine: DockerEngine = {
      ...unusedEngine(),
      container: async (reference) => (reference === 'c' ? container({ rawState: 'paused', state: 'running' }) : undefined),
      inspect: async (kind, reference) => (reference === 'there' ? (kind === 'image' ? { Id: 'sha256:1', Config: { Labels: { a: 'b' } } } : { Name: 'there' }) : undefined),
    };
    const docker = new EngineDocker(engine);
    expect(await docker.containerState('c')).toBe('running');
    expect(await docker.containerState('x')).toBe('missing');
    expect([await docker.imageExists('there'), await docker.imageExists('x')]).toEqual([true, false]);
    expect([await docker.imageId('there'), await docker.imageId('x')]).toEqual(['sha256:1', undefined]);
    expect([await docker.volumeExists('there'), await docker.volumeExists('x')]).toEqual([true, false]);
    expect([await docker.imageLabels('there'), await docker.imageLabels('x')]).toEqual([{ a: 'b' }, undefined]);
    await expect(docker.imageConfig('x')).rejects.toThrow('No such image: x');
    expect(await docker.imageConfig('there')).toEqual({ Labels: { a: 'b' } });
  });

  it('stopContainer: a missing container is no failure; other failures are', async () => {
    let failure: Error = new EngineError('No such container', 404);
    const engine: DockerEngine = {
      ...unusedEngine(),
      stop: async () => {
        throw failure;
      },
    };
    const docker = new EngineDocker(engine);
    await docker.stopContainer('c');
    failure = new EngineError('the daemon is busy', 500);
    await expect(docker.stopContainer('c')).rejects.toThrow('the daemon is busy');
  });

  it('labelImage: labels without a build, and removes the previous image only when nothing names it', async () => {
    const removed: string[] = [];
    let names: unknown = { Id: 'sha256:old', RepoTags: [], RepoDigests: [] };
    const engine: DockerEngine = {
      ...unusedEngine(),
      inspect: async (_kind, reference) => (reference === 'img:1' ? { Id: 'sha256:old' } : names),
      labelImage: async () => 'sha256:new',
      removeImage: async (reference) => (removed.push(reference), 'removed'),
    };
    const docker = new EngineDocker(engine);
    await docker.labelImage('img:1', { a: 'b' });
    expect(removed).toEqual(['sha256:old']);
    names = { Id: 'sha256:old', RepoTags: ['other:1'], RepoDigests: [] };
    await docker.labelImage('img:1', { a: 'b' });
    expect(removed).toEqual(['sha256:old']);
    // An image that a digest still names is kept too.
    names = { Id: 'sha256:old', RepoTags: [], RepoDigests: [`r@sha256:${'d'.repeat(64)}`] };
    await docker.labelImage('img:1', { a: 'b' });
    expect(removed).toEqual(['sha256:old']);
    const missing: DockerEngine = { ...unusedEngine(), inspect: async () => undefined };
    await expect(new EngineDocker(missing).labelImage('img:1', {})).rejects.toThrow('The image img:1 does not exist.');
  });

  it('tagImage: the tag of the engine, with the signal of the call', async () => {
    const tagged: string[] = [];
    const engine: DockerEngine = { ...unusedEngine(), tagImage: async (image, reference, signal) => void tagged.push(`${image} ${reference} ${signal !== undefined}`) };
    await new EngineDocker(engine).tagImage('sha256:abc', `${NAME}:2`);
    expect(tagged).toEqual([`sha256:abc ${NAME}:2 true`]);
    const failing: DockerEngine = { ...unusedEngine(), tagImage: async () => Promise.reject(new EngineError('no such image', 404)) };
    await expect(new EngineDocker(failing).tagImage('sha256:abc', `${NAME}:2`)).rejects.toThrow('no such image');
  });

  it('inspectImageNames: found ones, invalid references, and the rest transient after the first other failure', async () => {
    const engine: DockerEngine = {
      ...unusedEngine(),
      inspect: async (_kind, reference) => {
        if (reference === 'bad') throw new EngineError('invalid reference format', 400);
        if (reference === 'down') throw new EngineError('the daemon is busy', 500);
        return reference === 'gone' ? undefined : { Id: `sha256:${reference}`, RepoTags: [`${reference}:1`], RepoDigests: [] };
      },
    };
    const { logger, lines } = recording();
    const result = await new EngineDocker(engine, logger).inspectImageNames(['a', 'gone', 'bad', 'b', 'down', 'c']);
    expect(result.images.map((image) => image.id)).toEqual(['sha256:a', 'sha256:b']);
    expect(result.unchecked).toEqual([
      { reference: 'bad', reason: 'invalid' },
      { reference: 'down', reason: 'transient' },
      { reference: 'c', reason: 'transient' },
    ]);
    expect(lines).toEqual(['warn The inspect of the image down failed: the daemon is busy']);
  });

  it('the image lists: project images without those of another devspace, devspace images, sorted tags', async () => {
    const image = (repoTags: string[], labels: Record<string, string> = {}): EngineImage => ({ id: `sha256:${repoTags.join()}`, repoTags, repoDigests: [], labels, created: '2026-10-03T10:00:00.000Z' });
    const filters: unknown[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      images: async (given) => {
        filters.push(given);
        const reference = given.reference?.[0];
        if (reference === 'p-*') return [image(['p-app:latest'], { [LABEL_DEVSPACE_ID]: ENV }), image(['p-db:latest'], { [LABEL_DEVSPACE_ID]: 'other' })];
        if (reference === 'devspaces-*') return [image(['devspaces-a:1', 'devspaces-a:2']), image([])];
        return [image(['devspaces-a:10', 'devspaces-a:2', 'devspaces-ab:1'])];
      },
    };
    const docker = new EngineDocker(engine);
    expect(await docker.listProjectImages('p', ENV)).toEqual(['p-app:latest']);
    expect(await docker.listProjectImages('p')).toEqual(['p-app:latest', 'p-db:latest']);
    expect(await docker.listDevspaceImages()).toEqual([{ id: 'sha256:devspaces-a:1,devspaces-a:2', tags: ['devspaces-a:1', 'devspaces-a:2'], createdAt: '2026-10-03T10:00:00.000Z' }]);
    expect(await docker.listImageTags('devspaces-a')).toEqual(['devspaces-a:2', 'devspaces-a:10']);
    expect(filters).toContainEqual({ reference: ['devspaces-a'] });
  });

  it('exec: the input or the secret input as standard input, never both', async () => {
    const seen: unknown[] = [];
    const engine: DockerEngine = { ...unusedEngine(), exec: async (c, command, options) => (seen.push([c, command, options]), { exitCode: 0, stdout: 'x', stderr: '', timedOut: false }) };
    const docker = new EngineDocker(engine, silentLogger, (name) => (name === SECRET_TOKEN ? 'ghp_x' : name === SECRET_REGISTRY ? 'registry-password' : undefined));
    // The secret input comes by its name (`secretInputName`, as the registry's runScript gives it), never as its value.
    expect(await docker.exec('c', ['cat'], { user: 'root', secretInputName: SECRET_TOKEN, timeoutMs: 5 })).toEqual({ exitCode: 0, stdout: 'x', stderr: '', timedOut: false });
    // The secret goes to the port by its name, never as its value.
    expect(seen[0]).toEqual(['c', ['cat'], { user: 'root', secretInputName: SECRET_TOKEN, timeoutMs: 5 }]);
    expect(JSON.stringify(seen[0])).not.toContain('ghp_x');
    await expect(docker.exec('c', ['cat'], { input: 'a', secretInputName: SECRET_TOKEN })).rejects.toThrow('either an input or a secret input');
    // A secret input that is not the token of the operation is refused before anything is sent, by its name: another
    // secret of the operation (its registry login) never goes into a container, and the token is refused when the
    // operation holds none.
    await expect(docker.exec('c', ['cat'], { secretInputName: SECRET_REGISTRY as typeof SECRET_TOKEN })).rejects.toThrow('token secret of the operation');
    await expect(new EngineDocker(engine).exec('c', ['cat'], { secretInputName: SECRET_TOKEN })).rejects.toThrow('token secret of the operation');
    // The token that the operation holds is checked where it is sent: empty, or with white space, it is refused before
    // anything is sent.
    for (const held of ['', 'ghp_a b', 'ghp_x\n']) {
      await expect(new EngineDocker(engine, silentLogger, (name) => (name === SECRET_TOKEN ? held : undefined)).exec('c', ['cat'], { secretInputName: SECRET_TOKEN })).rejects.toThrow('token secret of the operation');
    }
    expect(seen).toHaveLength(1);
    await docker.exec('c', ['id'], { input: 'plain', workdir: '/w' });
    expect(seen).toEqual([seen[0], ['c', ['id'], { input: 'plain', workdir: '/w' }]]);
  });

  it('exec: a refusal of the engine is a result as `docker exec` gives it; a cancel and other failures stay failures', async () => {
    let failure: Error = new EngineError('unable to find user nobody2: no matching entries in passwd file', 400);
    const engine: DockerEngine = {
      ...unusedEngine(),
      exec: async () => {
        throw failure;
      },
    };
    const docker = new EngineDocker(engine);
    expect(await docker.exec('c', ['id'], { user: 'nobody2' })).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'Error response from daemon: unable to find user nobody2: no matching entries in passwd file\n',
      timedOut: false,
    });
    failure = new EngineError('container c is not running', 409);
    expect((await docker.exec('c', ['id'])).stderr).toBe('Error response from daemon: container c is not running\n');
    failure = new EngineError('The operation holds no secret token.', 0);
    await expect(docker.exec('c', ['id'])).rejects.toBe(failure);
    failure = new Error('socket hang up');
    await expect(docker.exec('c', ['id'])).rejects.toBe(failure);
    const controller = new AbortController();
    controller.abort();
    failure = new EngineError('cancelled while refused', 409);
    await expect(docker.exec('c', ['id'], { signal: controller.signal })).rejects.toBe(failure);
  });

  it('each request has a time limit; a cancel stays an AbortError', async () => {
    // As the port: a request ends with an AbortError when its signal aborts.
    const hanging = <T>(signal?: AbortSignal): Promise<T> =>
      new Promise((_resolve, reject) => {
        const fail = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal?.aborted) fail();
        signal?.addEventListener('abort', fail);
      });
    const signals: (AbortSignal | undefined)[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      // imageFile, which imageUserIds reads.
      imageFile: (_image, _path, signal) => (signals.push(signal), hanging(signal)),
      inspect: (_kind, _reference, signal) => (signals.push(signal), hanging(signal)),
      start: (_id, signal) => (signals.push(signal), hanging(signal)),
    };
    const docker = new EngineDocker(engine);
    // The time limit of imageUserIds.
    await expect(docker.imageUserIds('img', 'vscode', { timeoutMs: 20 })).rejects.toThrow(new EngineError('The engine did not answer the read of /etc/passwd of img within 0.02 s.', 0));
    await expect(docker.imageConfig('img', { timeoutMs: 20 })).rejects.toThrow('did not answer the inspect of img within 0.02 s');
    await expect(docker.startContainer('c', { timeoutMs: 20 })).rejects.toThrow('did not answer the start of c within 0.02 s');
    const controller = new AbortController();
    // The cancel of imageUserIds.
    const cancelled = docker.imageUserIds('img', 'vscode', { signal: controller.signal, timeoutMs: 60_000 });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    // The signal of the caller reaches the port.
    const passed = docker.imageConfig('img', { signal: controller.signal });
    await expect(passed).rejects.toMatchObject({ name: 'AbortError' });
    expect(signals.every((signal) => signal !== undefined)).toBe(true);
    expect(signals.at(-1)?.aborted).toBe(true);
  });

  it('the signal and the filter of each list reach the port', async () => {
    const seen: unknown[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      containerIds: async (filters, signal) => (seen.push(['ids', filters, signal?.aborted]), ['id1']),
      // With the exit code and the restarts of the port, which no list of the pipeline carries.
      containers: async (label) => (seen.push(['containers', label]), [container({ exitCode: 3, restartCount: 2 })]),
      inspect: async (_kind, reference, signal) => (seen.push(['inspect', reference, signal?.aborted]), { Id: 'sha256:1' }),
      version: async (signal) => (seen.push(['version', signal?.aborted]), { apiVersion: '1.48', version: '29.0.0' }),
    };
    const docker = new EngineDocker(engine);
    const controller = new AbortController();
    // A signal that aborts later: the port gets one that follows it.
    const late = { aborted: false };
    controller.signal.addEventListener('abort', () => (late.aborted = true));
    // The image has no configuration: as `docker image inspect --format {{json .Config}}`, null.
    expect(await docker.imageConfig('img')).toBeNull();
    // The list of the devspaces carries the time of the create of each container, which the rule of the dev
    // container (devContainerOf) needs; the other fields of the port (the exit code, the restarts) stay out.
    expect(await docker.listDevspaceContainers()).toEqual([expect.objectContaining({ created: '2026-10-03T10:00:00Z' })]);
    expect((await docker.listDevspaceContainers())[0]).not.toHaveProperty('exitCode');
    expect((await docker.listDevspaceContainers())[0]).not.toHaveProperty('restartCount');
    expect(seen).toContainEqual(['containers', LABEL_DEVSPACE_ID]);
    expect((await docker.listProjectContainers('acme'))[0]).not.toHaveProperty('created');
    expect(seen.at(-1)).toEqual(['containers', 'com.docker.compose.project=acme']);
    const signals: AbortSignal[] = [];
    const watching: DockerEngine = {
      ...engine,
      version: async (signal) => (signals.push(signal!), { apiVersion: '1.48', version: '29.0.0' }),
      inspect: async (_kind, _reference, signal) => (signals.push(signal!), { Id: 'sha256:1' }),
      // imageFile, which imageUserIds reads.
      imageFile: async (_image, _path, signal) => (signals.push(signal!), undefined),
    };
    const watched = new EngineDocker(watching);
    await watched.isRunning(controller.signal);
    await watched.engineApiVersion(controller.signal);
    await watched.imageConfig('img', { signal: controller.signal });
    // The signal of imageUserIds reaches the port.
    await watched.imageUserIds('img', 'vscode', { signal: controller.signal });
    expect(signals).toHaveLength(4);
    controller.abort();
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true, true, true]);
  });

  it('isRunning and engineApiVersion: a cancel is never an answer', async () => {
    const abort = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' });
    let answer: () => Promise<{ apiVersion: string; version: string }> = async () => {
      throw abort();
    };
    const engine: DockerEngine = { ...unusedEngine(), version: () => answer() };
    const { logger, lines } = recording();
    const docker = new EngineDocker(engine, logger);
    // An AbortError without a signal of the caller (the engine went away while asked) is no answer either.
    await expect(docker.isRunning()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(docker.engineApiVersion()).rejects.toMatchObject({ name: 'AbortError' });
    // A cancel of the caller while the engine fails otherwise.
    const controller = new AbortController();
    answer = async () => {
      controller.abort();
      throw new Error('connect ENOENT');
    };
    await expect(docker.isRunning(controller.signal)).rejects.toThrow('connect ENOENT');
    await expect(docker.engineApiVersion(controller.signal)).rejects.toThrow('connect ENOENT');
    expect(lines).toEqual([]);
    // Only a version `<major>.<minor>` is one; an empty one is named.
    for (const apiVersion of ['v1.48', '1.48-beta', '1.48.1', '']) {
      answer = async () => ({ apiVersion, version: '' });
      expect(await docker.engineApiVersion()).toBeUndefined();
    }
    expect(lines.at(-1)).toBe('warn The API version of the Docker Engine could not be read: none');
  });

  it('findContainer: the named one also when another one runs or is newer', async () => {
    const named = container({ state: 'stopped', rawState: 'exited', created: '2026-10-01T00:00:00Z' });
    const other = container({ id: 'r'.repeat(64), name: 'running', created: '2026-10-03T12:00:00Z' });
    const engine: DockerEngine = { ...unusedEngine(), containers: async () => [other, named] };
    expect((await new EngineDocker(engine).findContainer(ENV, NAME))?.id).toBe(named.id);
  });

  describe('pullImage with the logins of the operation', () => {
    /** Logins as registryLogins gives them: the secret slot holds the password only during `use`. */
    function logins(answers: Record<string, { username?: string; identityToken?: boolean; password: string } | undefined>) {
      const state = { slot: undefined as string | undefined, events: [] as string[] };
      const run: PullLogins = async ({ registry }, use) => {
        state.events.push(`ask ${registry}`);
        const login = answers[registry];
        state.slot = login?.password;
        try {
          return await use(login);
        } finally {
          state.slot = undefined;
          state.events.push('forget');
        }
      };
      return { run, state };
    }

    /** Docker's answer to a pull without a login of a private repository (or of one that does not exist). */
    const PRIVATE = (repository: string) =>
      new EngineError(`pull access denied for ${repository}, repository does not exist or may require 'docker login': denied: requested access to the resource is denied`, 404);

    /**
     * An engine whose pull without a login fails with `refusal` for the references in `privateImages`; every other pull
     * works.
     */
    function engineWith(state: { slot: string | undefined; events: string[] }, privateImages: readonly string[] = [], refusal: (reference: string) => Error = PRIVATE) {
      const pulls: unknown[] = [];
      const engine: DockerEngine = {
        ...unusedEngine(),
        pull: async (reference, options) => {
          // The header is sent while the operation still holds the login.
          state.events.push(`pull ${reference} ${options?.login ? `with ${state.slot}` : 'anonymous'}`);
          if (options?.login === undefined && privateImages.includes(reference)) throw refusal(reference);
          pulls.push([reference, options?.login]);
        },
      };
      return { engine, pulls };
    }

    it('pulls without a login first: a public image asks for none; a refused pull asks for the login of its registry, pulls with it during its turn, and the operation forgets it after', async () => {
      const { run, state } = logins({ 'ghcr.io': { username: 'octo', password: 'gho_x' }, 'registry-1.docker.io': { identityToken: true, password: 'tok_y' } });
      const { engine, pulls } = engineWith(state, ['ghcr.io/o/i:1', 'acme/app:2']);
      const lines: string[] = [];
      const docker = new EngineDocker(engine, { ...silentLogger, info: (text) => void lines.push(text) }, (name) => (name === SECRET_REGISTRY ? state.slot : undefined), run);
      await docker.pullImage('node:22', { onOutput: () => {} });
      await docker.pullImage('ghcr.io/o/i:2', { onOutput: () => {} });
      expect(state.events).toEqual(['pull node:22 anonymous', 'pull ghcr.io/o/i:2 anonymous']);
      await docker.pullImage('ghcr.io/o/i:1', { onOutput: () => {} });
      await docker.pullImage('acme/app:2', { onOutput: () => {} });
      expect(state.events.slice(2)).toEqual([
        'pull ghcr.io/o/i:1 anonymous',
        'ask ghcr.io',
        'pull ghcr.io/o/i:1 with gho_x',
        'forget',
        'pull acme/app:2 anonymous',
        'ask registry-1.docker.io',
        'pull acme/app:2 with tok_y',
        'forget',
      ]);
      expect(pulls).toEqual([
        ['node:22', undefined],
        ['ghcr.io/o/i:2', undefined],
        ['ghcr.io/o/i:1', { serveraddress: 'ghcr.io', username: 'octo', secretName: SECRET_REGISTRY }],
        ['acme/app:2', { serveraddress: credentialServerName('registry-1.docker.io'), identityToken: true, secretName: SECRET_REGISTRY }],
      ]);
      expect(lines).toContain(
        "The pull of ghcr.io/o/i:1 without a login failed; it is pulled again with the login of this computer for ghcr.io: pull access denied for ghcr.io/o/i:1, repository does not exist or may require 'docker login': denied: requested access to the resource is denied",
      );
      expect(lines.join('\n')).not.toContain('gho_x');
    });

    it('without a login on this computer the failure of the pull stays; a reference that the parser refuses is not asked for; given credentials are used as they are', async () => {
      const { run, state } = logins({});
      const { engine, pulls } = engineWith(state, ['r.example/i:1', 'UPPER/Case:1']);
      const docker = new EngineDocker(engine, silentLogger, (name) => (name === SECRET_REGISTRY ? 'gho_given' : undefined), run);
      await expect(docker.pullImage('r.example/i:1', { onOutput: () => {} })).rejects.toThrow("pull access denied for r.example/i:1, repository does not exist or may require 'docker login'");
      await expect(docker.pullImage('UPPER/Case:1', { onOutput: () => {} })).rejects.toThrow('pull access denied for UPPER/Case:1');
      await docker.pullImage('ghcr.io/o/i:1', { credentials: { registry: 'ghcr.io', username: 'octo', password: 'gho_given' }, onOutput: () => {} });
      expect(state.events).toEqual(['pull r.example/i:1 anonymous', 'ask r.example', 'forget', 'pull UPPER/Case:1 anonymous', 'pull ghcr.io/o/i:1 with undefined']);
      expect(pulls).toEqual([['ghcr.io/o/i:1', { serveraddress: 'ghcr.io', username: 'octo', secretName: SECRET_REGISTRY }]]);
    });

    it("which failures of the pull without a login ask for the login: Docker's words for a refusal or a missing image, and Docker Hub's limit for pulls without a login", async () => {
      for (const [reference, failure, asked] of [
        ['ghcr.io/o/i:1', new EngineError('unauthorized: incorrect username or password', 500), true],
        ['ghcr.io/o/i:1', new EngineError('Head "https://ghcr.io/v2/o/i/manifests/1": unauthorized', 500), true],
        ['ghcr.io/o/i:1', new EngineError('forbidden', 403), true],
        ['ghcr.io/o/i:1', new EngineError('pull access denied', 401), true],
        // Docker without the containerd image store, with and without the words of the registry after it.
        ['o/i:1', new EngineError("pull access denied for o/i, repository does not exist or may require 'docker login'", 404), true],
        ['o/i:1', new EngineError("pull access denied for o/i, repository does not exist or may require 'docker login': denied: requested access to the resource is denied", 404), true],
        // The containerd image store, ghcr.io and ECR.
        ['o/i:1', new EngineError('failed to resolve reference "docker.io/o/i:1": pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed', 500), true],
        ['ghcr.io/o/i:1', new EngineError('failed to resolve reference "ghcr.io/o/i:1": failed to authorize: failed to fetch oauth token: unexpected status from POST request to https://ghcr.io/token: 403 Forbidden', 500), true],
        ['ghcr.io/o/i:1', new EngineError('Head "https://ghcr.io/v2/o/i/manifests/1": denied', 500), true],
        ['ghcr.io/o/i:1', new EngineError('denied: Your authorization token has expired. Reauthenticate and try again.', 500), true],
        // A registry with Basic authentication (ECR, a registry with a password file), Docker without the containerd
        // image store.
        ['r.example/i:1', new EngineError('Head "https://r.example/v2/i/manifests/1": no basic auth credentials', 500), true],
        // A registry can hide a private repository behind a 404: Docker without and with the containerd image store.
        ['ghcr.io/o/i:1', new EngineError('manifest for ghcr.io/o/i:1 not found: manifest unknown: manifest unknown', 404), true],
        ['ghcr.io/o/i:1', new EngineError('manifest unknown', 404), true],
        ['r.example/i:1', new EngineError('name unknown: repository name not known to registry', 500), true],
        ['ghcr.io/o/i:1', new EngineError('failed to resolve reference "ghcr.io/o/i:1": ghcr.io/o/i:1: not found', 500), true],
        // Other failures of the containerd image store that end with `not found`, which a login cannot mend: an image
        // without a variant for the platform of the engine, and a missing blob of the local content store.
        ['mysql:5.7', new EngineError('no matching manifest for linux/arm64/v8 in the manifest list entries: no match for platform in manifest: not found', 500), false],
        ['ghcr.io/o/i:1', new EngineError(`content sha256:${'a'.repeat(64)}: not found`, 500), false],
        // Docker Hub limits the pulls without a login more than those with one; another registry's limit is no reason.
        ['node:22', new EngineError('toomanyrequests: You have reached your unauthenticated pull rate limit. https://www.docker.com/increase-rate-limit', 500), true],
        ['docker.io/library/node:22', new EngineError('Too Many Requests', 429), true],
        ['ghcr.io/o/i:1', new EngineError('toomanyrequests: retry later', 500), false],
        ['ghcr.io/o/i:1', new EngineError('Too Many Requests', 429), false],
        ['ghcr.io/o/i:1', new EngineError('pull access for o/i is not possible: repository does not exist or may require login (denied later)', 500), false],
        ['ghcr.io/o/i:1', new EngineError('Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host', 500), false],
        ['ghcr.io/o/i:1', new Error('no space left on device'), false],
      ] as const) {
        const { run, state } = logins({
          'ghcr.io': { username: 'octo', password: 'gho_x' },
          'registry-1.docker.io': { username: 'hub', password: 'hub_x' },
          'r.example': { username: 'aws', password: 'ecr_x' },
        });
        const { engine } = engineWith(state, [reference], () => failure);
        const docker = new EngineDocker(engine, silentLogger, (name) => (name === SECRET_REGISTRY ? state.slot : undefined), run);
        const pulled = docker.pullImage(reference, { onOutput: () => {} });
        if (asked) {
          await expect(pulled, failure.message).resolves.toBeUndefined();
          expect(state.events, failure.message).toEqual([`pull ${reference} anonymous`, expect.stringMatching(/^ask /), expect.stringMatching(new RegExp(`^pull ${reference} with `)), 'forget']);
        } else {
          await expect(pulled, failure.message).rejects.toThrow(failure.message);
          expect(state.events, failure.message).toEqual([`pull ${reference} anonymous`]);
        }
      }
    });

    it('a login that the registry refuses fails the pull, with a warning that names no password; the login is forgotten', async () => {
      const { run, state } = logins({ 'ghcr.io': { username: 'octo', password: 'gho_old' } });
      const warnings: string[] = [];
      const refusal = new EngineError('unauthorized: incorrect username or password', 500);
      const engine: DockerEngine = {
        ...unusedEngine(),
        pull: async (reference, options) => {
          state.events.push(`pull ${reference} ${options?.login ? `with ${state.slot}` : 'anonymous'}`);
          throw options?.login ? refusal : PRIVATE(reference);
        },
      };
      const docker = new EngineDocker(engine, { ...silentLogger, warn: (text) => void warnings.push(text) }, (name) => (name === SECRET_REGISTRY ? state.slot : undefined), run);
      await expect(docker.pullImage('ghcr.io/o/i:1', { onOutput: () => {} })).rejects.toBe(refusal);
      expect(state.events).toEqual(['pull ghcr.io/o/i:1 anonymous', 'ask ghcr.io', 'pull ghcr.io/o/i:1 with gho_old', 'forget']);
      expect(warnings).toEqual(['The pull of ghcr.io/o/i:1 with the login of this computer for ghcr.io was refused: unauthorized: incorrect username or password']);
      expect(state.slot).toBeUndefined();
    });

    it('a pull cancelled during its try without a login asks for no login; one cancelled during its try with the login fails without a warning', async () => {
      const { run, state } = logins({ 'ghcr.io': { username: 'octo', password: 'gho_old' } });
      const warnings: string[] = [];
      let cancel = new AbortController();
      let cancelWith: 'anonymous' | 'login' = 'anonymous';
      let pulls = 0;
      const engine: DockerEngine = {
        ...unusedEngine(),
        pull: async (_reference, options) => {
          pulls++;
          if ((options?.login === undefined) === (cancelWith === 'anonymous')) cancel.abort();
          throw new EngineError('unauthorized', 401);
        },
      };
      const docker = new EngineDocker(engine, { ...silentLogger, warn: (text) => void warnings.push(text) }, (name) => (name === SECRET_REGISTRY ? state.slot : undefined), run);
      await expect(docker.pullImage('ghcr.io/o/i:1', { onOutput: () => {}, signal: cancel.signal })).rejects.toThrow('unauthorized');
      expect(pulls).toBe(1);
      expect(state.events).toEqual([]);
      cancel = new AbortController();
      cancelWith = 'login';
      await expect(docker.pullImage('ghcr.io/o/i:1', { onOutput: () => {}, signal: cancel.signal })).rejects.toThrow('unauthorized');
      expect(pulls).toBe(3);
      expect(state.events).toEqual(['ask ghcr.io', 'forget']);
      expect(warnings).toEqual([]);
    });

    it('the pull with the login keeps the output and the signal of the pull', async () => {
      const { run, state } = logins({ 'ghcr.io': { username: 'octo', password: 'gho_x' } });
      const seen: { login: boolean; signal: AbortSignal | undefined }[] = [];
      const engine: DockerEngine = {
        ...unusedEngine(),
        pull: async (_reference, options) => {
          seen.push({ login: options?.login !== undefined, signal: options?.signal });
          if (!options?.login) throw new EngineError('unauthorized', 401);
          options?.onLine?.('done');
        },
      };
      const output: string[] = [];
      const signal = new AbortController().signal;
      const docker = new EngineDocker(engine, silentLogger, (name) => (name === SECRET_REGISTRY ? state.slot : undefined), run);
      await docker.pullImage('ghcr.io/o/i:1', { onOutput: (text) => void output.push(text), signal });
      expect(seen).toEqual([
        { login: false, signal },
        { login: true, signal },
      ]);
      expect(output).toEqual(['done\n']);
    });

    it('a login only for a registry that the daemon reads the same way; the Docker Hub aliases and a port', async () => {
      const { run, state } = logins({ 'registry-1.docker.io': { username: 'hub', password: 'hub_x' }, 'localhost:5000': { username: 'local', password: 'local_x' } });
      // Every pull without a login is refused, so each reference whose registry a login fits asks for it.
      const pulls: unknown[] = [];
      const engine: DockerEngine = {
        ...unusedEngine(),
        pull: async (reference, options) => {
          if (options?.login === undefined) throw PRIVATE(reference);
          pulls.push([reference, options.login]);
        },
      };
      const docker = new EngineDocker(engine, silentLogger, (name) => (name === SECRET_REGISTRY ? state.slot : undefined), run);
      // Also an upper-case first part without a dot or a colon (a host to Docker).
      for (const reference of ['Docker.io/library/node:22', 'INDEX.DOCKER.IO/library/node:22', ' node:22', 'node:22 ', 'MyHost/img:1', 'LOCALHOST/img:1']) {
        await expect(docker.pullImage(reference, { onOutput: () => {} }), reference).rejects.toThrow('pull access denied');
      }
      expect(state.events.filter((event) => event.startsWith('ask'))).toEqual([]);
      for (const reference of ['docker.io/library/node:22', 'index.docker.io/library/node:22', 'localhost:5000/team/app:1']) {
        await docker.pullImage(reference, { onOutput: () => {} });
      }
      expect(state.events.filter((event) => event.startsWith('ask'))).toEqual(['ask registry-1.docker.io', 'ask registry-1.docker.io', 'ask localhost:5000']);
      expect(pulls.at(-1)).toEqual(['localhost:5000/team/app:1', { serveraddress: credentialServerName('localhost:5000'), username: 'local', secretName: SECRET_REGISTRY }]);
      expect(credentialServerName('localhost:5000')).toBe('localhost:5000');
    });

    it('a failed pull with the login still ends its turn (the login is forgotten) and fails', async () => {
      const { run, state } = logins({ 'ghcr.io': { username: 'octo', password: 'gho_x' } });
      const engine: DockerEngine = {
        ...unusedEngine(),
        pull: async (reference, options) => Promise.reject(options?.login === undefined ? PRIVATE(reference) : new Error('manifest unknown')),
      };
      const docker = new EngineDocker(engine, silentLogger, (name) => (name === SECRET_REGISTRY ? state.slot : undefined), run);
      await expect(docker.pullImage('ghcr.io/o/i:1', { onOutput: () => {} })).rejects.toThrow('manifest unknown');
      expect(state.events).toEqual(['ask ghcr.io', 'forget']);
      expect(state.slot).toBeUndefined();
    });
  });

  it('pullImage: anonymous, or with the registry secret that the operation holds, and the lines as output', async () => {
    const pulls: unknown[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      pull: async (reference, options) => {
        pulls.push([reference, options?.login]);
        options?.onLine?.('1: Pulling');
      },
    };
    const output: string[] = [];
    const docker = new EngineDocker(engine, silentLogger, (name) => (name === SECRET_REGISTRY ? 'gho_x' : undefined));
    await docker.pullImage('alpine:1', { onOutput: (text) => output.push(text) });
    await docker.pullImage('ghcr.io/o/i:1', { credentials: { registry: 'ghcr.io', username: 'octo', password: 'gho_x' }, onOutput: () => {} });
    await docker.pullImage('r.example/i:1', { credentials: { registry: 'r.example', username: '<token>', password: 'gho_x' }, onOutput: () => {} });
    expect(pulls).toEqual([
      ['alpine:1', undefined],
      ['ghcr.io/o/i:1', { serveraddress: 'ghcr.io', username: 'octo', secretName: SECRET_REGISTRY }],
      ['r.example/i:1', { serveraddress: 'r.example', identityToken: true, secretName: SECRET_REGISTRY }],
    ]);
    expect(output).toEqual(['1: Pulling\n']);
    // A reference without a tag is pulled as `:latest`; one with a digest as it is.
    await docker.pullImage('node', { onOutput: () => {} });
    await docker.pullImage('ghcr.io/o/i', { onOutput: () => {} });
    await docker.pullImage(`node@sha256:${'a'.repeat(64)}`, { onOutput: () => {} });
    expect(pulls.slice(3).map((pull) => (pull as unknown[])[0])).toEqual(['node:latest', 'ghcr.io/o/i:latest', `node@sha256:${'a'.repeat(64)}`]);
    pulls.splice(3);
    // An empty tag stays one, and the port refuses it.
    const requests: string[] = [];
    const refusing = dockerEngine(async (request) => {
      requests.push(request.path);
      return { status: 200, body: '', truncated: false };
    }, engineHijack('/nonexistent/docker.sock'));
    await expect(new EngineDocker(refusing).pullImage('node:', { onOutput: () => {} })).rejects.toThrow('The pull of node: needs a tag or a digest.');
    expect(requests).toEqual([]);
    // A password that is not the secret of the operation is refused before anything is sent.
    await expect(docker.pullImage('ghcr.io/o/i:1', { credentials: { registry: 'ghcr.io', username: 'octo', password: 'other' } })).rejects.toThrow('registry secret of the operation');
    expect(pulls).toHaveLength(3);
  });

  it('isRunning and engineApiVersion from the version of the engine', async () => {
    let answer: () => Promise<{ apiVersion: string; version: string }> = async () => ({ apiVersion: '1.48', version: '29.0.0' });
    const engine: DockerEngine = { ...unusedEngine(), version: () => answer() };
    const { logger, lines } = recording();
    const docker = new EngineDocker(engine, logger);
    expect([await docker.isRunning(), await docker.engineApiVersion()]).toEqual([true, '1.48']);
    answer = async () => ({ apiVersion: 'x', version: '' });
    expect(await docker.engineApiVersion()).toBeUndefined();
    answer = async () => {
      throw new Error('connect ENOENT');
    };
    expect([await docker.isRunning(), await docker.engineApiVersion()]).toEqual([false, undefined]);
    expect(lines).toEqual(['warn The API version of the Docker Engine could not be read: x', 'warn The API version of the Docker Engine could not be read: connect ENOENT']);
    const controller = new AbortController();
    controller.abort();
    answer = async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    await expect(docker.isRunning(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('imageUserIds reads /etc/passwd of the image through the port and resolves the user as `id` does', async () => {
    const reads: { image: string; path: string }[] = [];
    let passwd: string | undefined = 'root:x:0:0:root:/root:/bin/sh\nvscode:x:1000:1001::/home/vscode:/bin/bash\n';
    const engine: DockerEngine = { ...unusedEngine(), imageFile: async (image, path) => (reads.push({ image, path }), passwd) };
    const docker = new EngineDocker(engine);
    expect(await docker.imageUserIds('img:1', 'vscode')).toEqual({ uid: '1000', gid: '1001' });
    expect(reads).toEqual([{ image: 'img:1', path: '/etc/passwd' }]);
    expect(await docker.imageUserIds('img:1', '1000')).toEqual({ uid: '1000', gid: '1001' });
    expect(await docker.imageUserIds('img:1', 'node')).toBeUndefined();
    // No regular file at the path (missing, a link, too large): unknown.
    passwd = undefined;
    expect(await docker.imageUserIds('img:1', 'vscode')).toBeUndefined();
    // A failure of the engine stays a failure.
    const failing: DockerEngine = { ...unusedEngine(), imageFile: async () => Promise.reject(new EngineError('No such image: img:1', 404)) };
    await expect(new EngineDocker(failing).imageUserIds('img:1', 'vscode')).rejects.toMatchObject({ status: 404 });
  });
});
