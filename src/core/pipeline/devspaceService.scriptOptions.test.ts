// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Probes of the call sites of the script registry (runScript in devspaceService.ts): the user, the time limit and
// the cancel of each script. FakeDocker records the user and the signal of an exec but not its time limit, so the
// probes record the options of each exec themselves.
import { afterEach, describe, expect, it } from 'vitest';
import { servicePathArguments } from '../git/gitSummary';
import type { ComposeModel } from '../helper/composeModel';
import { composeConfigHash, composeInputsHash, type ComposeModelOutput } from '../helper/compose';
import { Messages } from '../messages';
import { CONTAINER_VERSION, LABEL_COMPOSE_SERVICE, LABEL_CONTAINER_VERSION, composeProjectName } from '../names';
import { SECRET_TOKEN } from '../helperChannel/protocol';
import { CONTAINER_SCRIPTS, type ContainerScript } from '../worker/containerScripts';
import { BRANCH_EXEC_TIMEOUT_MS } from './refreshStates';
import { BASE_IMAGE, DIGEST_NEW, ENV_ID, FEATURE, FEATURE_DIGEST, REPO, checked, createHarness, seedDevspace, type Harness } from './devspaceService.testkit';
import type { RepositoryTarget } from './operationBase';
import { DEFAULT_CONFIG_PATH } from './recordRules';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
/** GIT_EXEC_TIMEOUT_MS and OWNERSHIP_TIMEOUT_MS of devspaceService.ts (module-private). */
const GIT_EXEC_TIMEOUT_MS = 30_000;
const OWNERSHIP_TIMEOUT_MS = 10 * 60_000;

let h: Harness;

afterEach(() => {
  h?.cleanup();
});

/** The entry of the registry whose command `command` is (the script text, or the fixed command of a `command` entry). */
function entryOf(command: readonly string[]): ContainerScript | undefined {
  return (Object.keys(CONTAINER_SCRIPTS) as ContainerScript[]).find((name) => {
    const entry: { command?: readonly string[]; script?: string } = CONTAINER_SCRIPTS[name];
    return entry.command !== undefined ? entry.command.every((part, index) => command[index] === part) : command[2] === entry.script;
  });
}

/** Each exec of the pipeline from now on: its entry and its options as the port gets them (with the time limit). */
function recordExecs(harness: Harness): Array<{ entry: ContainerScript | undefined; options: Record<string, unknown> }> {
  const seen: Array<{ entry: ContainerScript | undefined; options: Record<string, unknown> }> = [];
  const exec = harness.docker.exec.bind(harness.docker);
  harness.docker.exec = async (container, command, options = {}) => {
    seen.push({ entry: entryOf(command), options: { ...options } });
    return exec(container, command, options);
  };
  return seen;
}

/** Every run of the script `name` in `seen` (at least one) had exactly the options `expected`. */
function expectOptions(seen: ReturnType<typeof recordExecs>, name: ContainerScript, expected: Record<string, unknown>): void {
  const runs = seen.filter(({ entry }) => entry === name).map(({ options }) => options);
  expect(runs.length, name).toBeGreaterThan(0);
  for (const options of runs) expect(options, name).toEqual(expected);
}

describe('the options of each script of the open', () => {
  it('a first open runs each script with its user, its time limit and the cancel of the open', async () => {
    h = createHarness();
    const seen = recordExecs(h);
    const signal = new AbortController().signal;
    await h.service.open(TARGET, { progress: h.progress, signal });
    // tokenWrite: holds the signal of writeGitToken (another test holds its time limit).
    expectOptions(seen, 'tokenWrite', { user: 'root', timeoutMs: GIT_EXEC_TIMEOUT_MS, signal, secretInputName: SECRET_TOKEN });
    // homeGitConfig: holds its time limit and its signal.
    expectOptions(seen, 'homeGitConfig', { user: 'root', timeoutMs: GIT_EXEC_TIMEOUT_MS, signal });
    // ownershipFix: holds the time limit of the fix of the whole repository and its signal.
    expectOptions(seen, 'ownershipFix', { user: 'root', timeoutMs: OWNERSHIP_TIMEOUT_MS, signal });
    // userId and groupId: hold their time limit and their signal.
    expectOptions(seen, 'userId', { user: 'root', timeoutMs: OWNERSHIP_TIMEOUT_MS, signal });
    expectOptions(seen, 'groupId', { user: 'root', timeoutMs: OWNERSHIP_TIMEOUT_MS, signal });
    // gitVersion: holds its time limit and its signal.
    expectOptions(seen, 'gitVersion', { user: 'vscode', timeoutMs: BRANCH_EXEC_TIMEOUT_MS, signal });
  });

  it('an open of a running container checks it and reads its branch with the user, time limit and cancel of the open', async () => {
    h = createHarness();
    await seedDevspace(h, {
      container: 'running',
      containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), 'devcontainer.metadata': JSON.stringify([{ remoteUser: 'vscode' }]) },
    });
    const seen = recordExecs(h);
    const signal = new AbortController().signal;
    await h.service.open(TARGET, { progress: h.progress, signal });
    // check (runningContainerFault): holds its time limit and its signal.
    expectOptions(seen, 'check', { user: 'vscode', timeoutMs: BRANCH_EXEC_TIMEOUT_MS, signal });
    // branch (branchInContainer through readBranch): holds its user: without it, the read runs as the user of the
    // image, which can differ from the remote user; the cancel test holds its signal.
    expectOptions(seen, 'branch', { user: 'vscode', timeoutMs: BRANCH_EXEC_TIMEOUT_MS, signal });
  });
});

describe('the token of the session that the script cannot take', () => {
  it.each([
    ['a tab', 'gho_with\ttab'],
    ['a line break', 'gho_line\nbreak'],
  ])('a token with %s is refused before any exec, with a warning', async (_what, token) => {
    // Any white space is refused, not only a space: TOKEN_WRITE_SCRIPT writes its standard input into the token file as
    // it is (`cat`), so a line break would reach the credential helper of the container.
    h = createHarness();
    h.token = token;
    await seedDevspace(h, { container: 'running' });
    await h.service.openDevspace(ENV_ID, { progress: h.progress });
    expect(h.docker.execs.filter((exec) => entryOf(exec.command) === 'tokenWrite')).toEqual([]);
    expect(h.logger.errors.some((line) => line.includes('The GitHub token could not be written') && line.includes('No valid GitHub token.'))).toBe(true);
    expect(h.ui.warnings).toEqual([Messages.gitSetupFailed]);
  });
});

/**
 * The Docker Compose configuration of devspaceService.compose.test.ts (a dev service `app` and a `db` service), as far
 * as the probes of the two scripts that only a Compose open runs need it: `existingPaths` and `mountInfo`.
 */
describe('the options of the scripts of a Docker Compose open', () => {
  const PROJECT = composeProjectName(REPO, ENV_ID);
  const FOLDER = '/workspaces/api';
  const DB_IMAGE = 'postgres:16';
  const DB_DIGEST = `sha256:${'d'.repeat(64)}`;
  const COMPOSE_LABELS = { 'com.docker.compose.project': PROJECT, 'com.docker.compose.container-number': '1' };
  const CONFIG_TEXT = `{
  "name": "API",
  "dockerComposeFile": ["compose.yml"],
  "service": "app",
  "workspaceFolder": "/workspaces/\${localWorkspaceFolderBasename}",
  "features": { "${FEATURE}": {} },
  "remoteUser": "vscode",
  "mounts": ["source=cache,target=/cache,type=volume"]
}`;

  function model(): ComposeModel {
    return {
      name: PROJECT,
      services: {
        app: {
          image: BASE_IMAGE,
          command: ['sleep', 'infinity'],
          volumes: [{ type: 'bind', source: '/workspaces', target: '/workspaces', bind: {} }],
          networks: { default: null },
        },
        db: {
          image: DB_IMAGE,
          volumes: [{ type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data', volume: {} }],
          networks: { default: null },
        },
      },
      networks: { default: { name: `${PROJECT}_default` } },
      volumes: { pgdata: { name: `${PROJECT}_pgdata` } },
    };
  }

  function output(changes: (m: ComposeModel) => void = () => undefined): ComposeModelOutput {
    const m = model();
    changes(m);
    return { version: '2.40.3', dollarEscaped: true, model: m, dockerfiles: {}, realPaths: { '/workspaces': '/workspaces' }, inputsHash: 'inputs-1' };
  }

  function useCompose(out: ComposeModelOutput = output()): void {
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT } };
    h.helper.composeOutput = out;
    h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST }, { [FEATURE]: FEATURE_DIGEST });
  }

  it('mountInfo: the mounts of the dev container are read as root, with the time limit of the ownership fix and the cancel of the open', async () => {
    // Holds the time limit and the signal of workspaceIdentities; the Compose tests hold only its command and user.
    h = createHarness({ newDevspaceId: () => ENV_ID });
    const SRC = `${FOLDER}/src`;
    const out = output((m) => {
      m.services.app.volumes = [...(m.services.app.volumes as unknown[]), { type: 'bind', source: SRC, target: SRC, bind: {} }];
    });
    out.realPaths = { ...out.realPaths, [SRC]: SRC };
    useCompose(out);
    const seen = recordExecs(h);
    const signal = new AbortController().signal;
    await h.service.open(TARGET, { progress: h.progress, signal });
    expectOptions(seen, 'mountInfo', { user: 'root', timeoutMs: OWNERSHIP_TIMEOUT_MS, signal });
  });

  const PGDATA = `${FOLDER}/pgdata`;
  const DATA = `${FOLDER}/data/pg`;

  /**
   * A stopped Compose devspace whose entry records ./pgdata as a path of a service, opened with a model whose db
   * keeps its data in ./data/pg (so ./pgdata is named by nothing but the record, and the check after `up` asks whether
   * it still exists), as a test of the paths of the services in devspaceService.compose.test.ts sets it up.
   */
  async function seedRetiredFolder(): Promise<void> {
    h = createHarness({ newDevspaceId: () => ENV_ID });
    useCompose();
    await seedDevspace(h, {
      container: 'stopped',
      containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), ...COMPOSE_LABELS, 'com.docker.compose.service': 'app' },
      record: {
        configHash: composeConfigHash(CONFIG_TEXT, model(), {}),
        images: { [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST },
        compose: { service: 'app', images: [`${PROJECT}-app`], serviceImages: [DB_IMAGE], version: '2.40.3', inputsHash: composeInputsHash(CONFIG_TEXT, 'inputs-1', {}) },
      },
    });
    h.docker.images.add(DB_IMAGE);
    await h.registry.updateDevspace(ENV_ID, (entry) => {
      entry.serviceFolders = [PGDATA];
    });
    const out = output((m) => {
      m.services.db.volumes = [{ type: 'bind', source: DATA, target: '/var/lib/postgresql/data', bind: {} }];
    });
    out.realPaths = { ...out.realPaths, [DATA]: DATA };
    useCompose(out);
  }

  it('existingPaths: the recorded paths of the services are checked as root, with the time limit of the ownership fix and the cancel of the open', async () => {
    // Holds the time limit and the signal of existingServiceFolders; the Compose tests hold only its user and its
    // paths.
    await seedRetiredFolder();
    const seen = recordExecs(h);
    const signal = new AbortController().signal;
    await h.service.openDevspace(ENV_ID, { progress: h.progress, forceRebuild: true, signal });
    expectOptions(seen, 'existingPaths', { user: 'root', timeoutMs: OWNERSHIP_TIMEOUT_MS, signal });
    expect(h.docker.containersOf(ENV_ID).some((container) => container.labels[LABEL_COMPOSE_SERVICE] === undefined)).toBe(true);
  });

  it('existingPaths: a check that fails (exit code) keeps the recorded paths of the services, and the ownership fix leaves them alone', async () => {
    // A failed check is never read as "none of them exists" (existingServiceFolders): that would drop ./pgdata from the
    // record, and the ownership fix after `up` would then give the data of the service in it to the remote user (data
    // damage). The Compose tests cover only a failed list of the containers ("never shrinks on an error"), not a failed
    // check.
    await seedRetiredFolder();
    // The volume does not have ./pgdata as far as the fake knows, so a check that worked would drop it.
    h.docker.missingPaths.add(PGDATA);
    h.docker.execHandler = (_container, command) => (entryOf(command) === 'existingPaths' ? { exitCode: 126, stderr: 'sh: permission denied' } : {});
    await h.service.openDevspace(ENV_ID, { progress: h.progress, forceRebuild: true });
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([DATA, PGDATA]);
    const fixes = h.docker.execs.filter((exec) => entryOf(exec.command) === 'ownershipFix' && exec.command[4] === FOLDER).map((exec) => exec.command.slice(4));
    expect(fixes).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [DATA, PGDATA])]]);
    expect(h.logger.warnings.some((line) => line.includes('could not be checked') && line.includes('permission denied'))).toBe(true);
  });
});

