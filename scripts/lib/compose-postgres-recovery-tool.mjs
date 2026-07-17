import { spawn, spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DOCKER_BINARY = "/usr/bin/docker";
const DOCKER_SOCKET = "/var/run/docker.sock";
const COMPOSE_FILE = "docker-compose.yml";
const COMPOSE_SERVICE = "postgres";
const POSTGRES_IMAGE = "postgres:17.10-bookworm";
const POSTGRES_MAJOR = 17;
const POSTGRES_CONTAINER_PORT = "5432";
const POSTGRES_PASSWORD_FILE = "/run/secrets/postgres_password";
const POSTGRES_DATA_DIRECTORY = "/var/lib/postgresql/data";
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_PASSWORD_BYTES = 8 * 1024;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const HELPER_CREATE_TIMEOUT_MS = 5_000;
const CLEANUP_QUIESCENCE_MS = 7_500;
const CLEANUP_POLL_MS = 250;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

export const COMPOSE_RECOVERY_PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function runComposePostgresRecoveryTool(tool, args, options = {}) {
  if (!["pg_dump", "pg_restore"].includes(tool)) {
    throw new Error("Unsupported PostgreSQL recovery tool");
  }
  const env = options.env ?? process.env;
  const projectRoot = path.resolve(options.projectRoot ?? COMPOSE_RECOVERY_PROJECT_ROOT);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const dependencies = {
    validateDockerHost: options.dependencies?.validateDockerHost ?? validateDockerHost,
    capture: options.dependencies?.capture ?? captureDockerCommand,
    runChild: options.dependencies?.runChild ?? runDockerChild,
    now: options.dependencies?.now ?? Date.now,
    sleep: options.dependencies?.sleep ?? synchronousSleep
  };

  const project = validateProjectRoot(projectRoot, cwd);
  dependencies.validateDockerHost({
    dockerBinary: options.dockerBinary ?? DOCKER_BINARY,
    dockerSocket: options.dockerSocket ?? DOCKER_SOCKET
  });
  const dockerBinary = options.dockerBinary ?? DOCKER_BINARY;
  const dockerSocket = options.dockerSocket ?? DOCKER_SOCKET;
  const dockerHost = `unix://${dockerSocket}`;
  const validationEnvironment = dockerClientEnvironment(env);
  const cleanupRunId = cleanupRunIdFromArguments(args);
  if (cleanupRunId) {
    cleanupRecoveryHelper({
      capture: dependencies.capture,
      dockerBinary,
      dockerHost,
      env: validationEnvironment,
      now: dependencies.now,
      project,
      requireQuiescence: true,
      runId: cleanupRunId,
      sleep: dependencies.sleep,
      tool
    });
    return { code: 0, signal: null };
  }
  const runId = requiredRunId(env.SALTANAT_RECOVERY_TOOL_RUN_ID);
  const internalTimeoutSeconds = recoveryInternalTimeoutSeconds(env.SALTANAT_RECOVERY_TOOL_TIMEOUT_MS);
  const composeBase = ["--host", dockerHost, "compose", "--project-directory", project.root, "--project-name", project.name, "--file", project.composeFile];
  const containerId = validateContainerId(
    dependencies.capture({
      command: dockerBinary,
      args: [
        "--host",
        dockerHost,
        "container",
        "ls",
        "--quiet",
        "--no-trunc",
        "--filter",
        "status=running",
        "--filter",
        `name=^/${project.name}-postgres-1$`,
        "--filter",
        `label=com.docker.compose.project=${project.name}`,
        "--filter",
        `label=com.docker.compose.service=${COMPOSE_SERVICE}`,
        "--filter",
        "label=com.docker.compose.oneoff=False"
      ],
      env: validationEnvironment,
      timeout: COMMAND_TIMEOUT_MS
    })
  );
  const inspected = parseJsonCapture(
    dependencies.capture({
      command: dockerBinary,
      args: ["--host", dockerHost, "inspect", "--type", "container", containerId],
      env: validationEnvironment,
      timeout: COMMAND_TIMEOUT_MS
    }),
    "Docker container inspection"
  );
  const discovered = discoverComposeContainerBoundary(inspected, {
    containerId,
    project
  });
  const composeEnvironment = {
    ...validationEnvironment,
    PGDATABASE: discovered.database,
    PGUSER: discovered.user,
    POSTGRES_HOST_PORT: discovered.publishedPort,
    POSTGRES_PASSWORD_FILE: discovered.secretSource
  };
  const compose = parseJsonCapture(
    dependencies.capture({
      command: dockerBinary,
      args: [...composeBase, "config", "--format", "json"],
      env: composeEnvironment,
      timeout: COMMAND_TIMEOUT_MS
    }),
    "Docker Compose configuration"
  );
  const boundary = validateComposeConfiguration(compose, project);
  const composeContainerId = validateContainerId(
    dependencies.capture({
      command: dockerBinary,
      args: [...composeBase, "ps", "--quiet", "--status", "running", COMPOSE_SERVICE],
      env: composeEnvironment,
      timeout: COMMAND_TIMEOUT_MS
    })
  );
  if (composeContainerId !== containerId) {
    throw new Error("Docker Compose resolved a different postgres container");
  }
  const containerBoundary = validateComposeContainer(inspected, {
    ...boundary,
    containerId,
    project
  });
  validatePostgresToolVersions(
    {
      pgDump: dependencies.capture({
        command: dockerBinary,
        args: ["--host", dockerHost, "exec", containerId, "/usr/bin/pg_dump", "--version"],
        env: validationEnvironment,
        timeout: COMMAND_TIMEOUT_MS
      }),
      pgRestore: dependencies.capture({
        command: dockerBinary,
        args: ["--host", dockerHost, "exec", containerId, "/usr/bin/pg_restore", "--version"],
        env: validationEnvironment,
        timeout: COMMAND_TIMEOUT_MS
      })
    },
    boundary.image
  );
  const plan = buildRecoveryToolPlan(tool, args, env, boundary);
  let opened;
  let helper;
  try {
    opened = plan.outputPath !== undefined ? openExclusiveDumpOutput(plan.outputPath) : plan.inputPath !== undefined ? openVerifiedDumpInput(plan.inputPath) : undefined;
    helper = createRecoveryHelper({
      boundary,
      capture: dependencies.capture,
      containerId,
      containerImageId: containerBoundary.imageId,
      dockerBinary,
      dockerHost,
      env,
      internalTimeoutSeconds,
      plan,
      project,
      recoveryGid: String(process.getgid?.()),
      recoveryUid: String(process.getuid?.()),
      runId,
      tool
    });
    const execution = buildDockerStartExecution({
      dockerBinary,
      dockerHost,
      env,
      helper,
      opened
    });
    const result = await dependencies.runChild(execution.command, execution.args, {
      env: execution.env,
      stdin: execution.stdin,
      stdout: options.stdout ?? process.stdout,
      stdoutDescriptor: opened?.kind === "output" ? opened.descriptor : undefined,
      stderr: options.stderr ?? process.stderr,
      redactions: plan.connect ? [env.PGPASSWORD] : []
    });
    if (opened?.kind === "output") {
      if (result.code === 0 && !result.signal) {
        fsyncSync(opened.descriptor);
        closeSync(opened.descriptor);
        opened.descriptor = undefined;
        assertOpenFileIdentity(opened, "PostgreSQL dump output");
        if (lstatSync(opened.path).size <= 0) {
          safeRemoveOutput(opened);
          throw new Error("PostgreSQL dump output is empty");
        }
      } else {
        closeOpenedFile(opened);
        safeRemoveOutput(opened);
      }
    } else if (opened?.kind === "input") {
      assertOpenFileIdentity(opened, "PostgreSQL dump input");
    }
    return result;
  } catch (error) {
    if (opened?.kind === "output") {
      closeOpenedFile(opened);
      safeRemoveOutput(opened);
    }
    throw error;
  } finally {
    if (helper) {
      cleanupRecoveryHelper({
        capture: dependencies.capture,
        dockerBinary,
        dockerHost,
        env: validationEnvironment,
        expectedContainerId: helper.containerId,
        now: dependencies.now,
        project,
        requireQuiescence: false,
        runId,
        sleep: dependencies.sleep,
        tool
      });
    }
    if (opened?.descriptor !== undefined) closeOpenedFile(opened);
  }
}

export function validateProjectRoot(projectRoot, cwd = process.cwd()) {
  assertNoSymlinkComponents(projectRoot, "Project root");
  const rootEntry = lstatSync(projectRoot);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error("Project root must be a real directory");
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && rootEntry.uid !== currentUid) {
    throw new Error("Project root must be owned by the recovery operator");
  }
  if (currentUid === 0) {
    throw new Error("Compose recovery wrappers must not run as root");
  }
  if ((rootEntry.mode & 0o022) !== 0) {
    throw new Error("Project root must not be group or world writable");
  }
  if (path.resolve(cwd) !== projectRoot) {
    throw new Error("Compose recovery wrappers must run from the exact project root");
  }
  const packageFile = path.resolve(projectRoot, "package.json");
  const composeFile = path.resolve(projectRoot, COMPOSE_FILE);
  const packageEntry = assertPrivateProjectFile(packageFile, "package.json");
  assertPrivateProjectFile(composeFile, COMPOSE_FILE);
  if (packageEntry.size > 256 * 1024) {
    throw new Error("Project package.json is too large");
  }
  const packageJson = JSON.parse(readFileSync(packageFile, "utf8"));
  if (packageJson?.name !== "saltanatbotv2" || packageJson?.private !== true || packageJson?.type !== "module") {
    throw new Error("Project root is not the SaltanatbotV2 repository");
  }
  const name = normalizeComposeProjectName(path.basename(projectRoot));
  if (!name) throw new Error("Project directory cannot form a Compose project name");
  return { root: projectRoot, name, composeFile };
}

export function discoverComposeContainerBoundary(inspected, context) {
  if (!Array.isArray(inspected) || inspected.length !== 1) {
    throw new Error("Docker discovery must return exactly one container");
  }
  const container = inspected[0];
  const labels = container?.Config?.Labels ?? {};
  if (
    !container ||
    container.Id !== context.containerId ||
    container.Name !== `/${context.project.name}-postgres-1` ||
    container.Config?.Image !== POSTGRES_IMAGE ||
    !/^sha256:[0-9a-f]{64}$/.test(String(container.Image ?? "")) ||
    labels["com.docker.compose.project"] !== context.project.name ||
    labels["com.docker.compose.service"] !== COMPOSE_SERVICE ||
    labels["com.docker.compose.container-number"] !== "1" ||
    labels["com.docker.compose.oneoff"] !== "False" ||
    labels["com.docker.compose.project.working_dir"] !== context.project.root ||
    labels["com.docker.compose.project.config_files"] !== context.project.composeFile
  ) {
    throw new Error("Discovered container is not this project's exact Compose postgres service");
  }
  if (container.State?.Status !== "running" || container.State?.Running !== true || container.State?.Paused === true || container.State?.Restarting === true || container.State?.Dead === true || container.State?.Health?.Status !== "healthy") {
    throw new Error("Discovered Compose postgres container is not running and healthy");
  }
  const bindings = container.HostConfig?.PortBindings;
  const publishedPort = String(bindings?.["5432/tcp"]?.[0]?.HostPort ?? "");
  if (!bindings || Object.keys(bindings).length !== 1 || !Array.isArray(bindings["5432/tcp"]) || bindings["5432/tcp"].length !== 1 || bindings["5432/tcp"][0]?.HostIp !== "127.0.0.1" || !isPort(publishedPort)) {
    throw new Error("Discovered Compose postgres port is not the exact loopback binding");
  }
  const environment = normalizeEnvironment(container.Config?.Env);
  const database = requiredPostgresName(environment.POSTGRES_DB, "Container POSTGRES_DB");
  const user = requiredPostgresName(environment.POSTGRES_USER, "Container POSTGRES_USER");
  if (environment.POSTGRES_PASSWORD !== undefined || environment.POSTGRES_PASSWORD_FILE !== POSTGRES_PASSWORD_FILE) {
    throw new Error("Discovered Compose postgres password configuration is invalid");
  }
  const dataMounts = (Array.isArray(container.Mounts) ? container.Mounts : []).filter((entry) => entry?.Destination === POSTGRES_DATA_DIRECTORY);
  if (dataMounts.length !== 1 || dataMounts[0]?.Type !== "volume" || dataMounts[0]?.Name !== `${context.project.name}_saltanat-postgres` || dataMounts[0]?.RW !== true) {
    throw new Error("Discovered Compose postgres data volume does not match");
  }
  const secretMounts = (Array.isArray(container.Mounts) ? container.Mounts : []).filter((entry) => entry?.Destination === POSTGRES_PASSWORD_FILE);
  if (secretMounts.length !== 1 || secretMounts[0]?.Type !== "bind" || secretMounts[0]?.RW !== false) {
    throw new Error("Discovered Compose postgres password-secret mount does not match");
  }
  const secretSource = requiredComposeSecretSource(secretMounts[0].Source);
  return {
    database,
    publishedPort,
    secretSource,
    user
  };
}

export function validateComposeConfiguration(value, project) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Docker Compose configuration must be an object");
  }
  if (value.name !== project.name) {
    throw new Error("Docker Compose project identity does not match the project root");
  }
  const service = value.services?.[COMPOSE_SERVICE];
  if (!service || typeof service !== "object" || Array.isArray(service)) {
    throw new Error("Docker Compose postgres service is missing");
  }
  if (service.image !== POSTGRES_IMAGE) {
    throw new Error(`Docker Compose postgres image must be exactly ${POSTGRES_IMAGE}`);
  }
  const ports = Array.isArray(service.ports) ? service.ports : [];
  if (ports.length !== 1) {
    throw new Error("Docker Compose postgres service must have one published port");
  }
  const port = ports[0];
  const publishedPort = String(port?.published ?? "");
  if (port?.host_ip !== "127.0.0.1" || String(port?.target ?? "") !== POSTGRES_CONTAINER_PORT || port?.protocol !== "tcp" || !isPort(publishedPort)) {
    throw new Error("Docker Compose postgres port must be one loopback-only TCP binding to container port 5432");
  }
  const environment = normalizeEnvironment(service.environment);
  const database = requiredPostgresName(environment.POSTGRES_DB, "Compose POSTGRES_DB");
  const user = requiredPostgresName(environment.POSTGRES_USER, "Compose POSTGRES_USER");
  if (environment.POSTGRES_PASSWORD !== undefined) {
    throw new Error("Docker Compose postgres service must not contain POSTGRES_PASSWORD");
  }
  if (environment.POSTGRES_PASSWORD_FILE !== POSTGRES_PASSWORD_FILE) {
    throw new Error("Docker Compose postgres service must use the reviewed password secret path");
  }
  const secretSource = requiredComposeSecretSource(value.secrets?.postgres_password?.file);
  const dataMounts = (Array.isArray(service.volumes) ? service.volumes : []).filter((entry) => entry?.target === POSTGRES_DATA_DIRECTORY);
  if (dataMounts.length !== 1 || dataMounts[0]?.type !== "volume" || dataMounts[0]?.source !== "saltanat-postgres") {
    throw new Error("Docker Compose postgres service must use the project PostgreSQL named volume");
  }
  return {
    image: service.image,
    publishedHost: "127.0.0.1",
    publishedPort,
    database,
    user,
    secretSource
  };
}

export function validateComposeContainer(inspected, context) {
  if (!Array.isArray(inspected) || inspected.length !== 1) {
    throw new Error("Docker inspect must return exactly one container");
  }
  const container = inspected[0];
  if (!container || container.Id !== context.containerId) {
    throw new Error("Docker container identity changed during inspection");
  }
  if (container.Name !== `/${context.project.name}-postgres-1`) {
    throw new Error("Docker container name is not the exact Compose postgres service");
  }
  if (container.State?.Status !== "running" || container.State?.Running !== true || container.State?.Paused === true || container.State?.Restarting === true || container.State?.Dead === true || container.State?.Health?.Status !== "healthy") {
    throw new Error("Docker Compose postgres container is not running and healthy");
  }
  if (container.Config?.Image !== context.image || !/^sha256:[0-9a-f]{64}$/.test(String(container.Image ?? ""))) {
    throw new Error("Docker Compose postgres container image identity is invalid");
  }
  const labels = container.Config?.Labels ?? {};
  const requiredLabels = {
    "com.docker.compose.project": context.project.name,
    "com.docker.compose.service": COMPOSE_SERVICE,
    "com.docker.compose.container-number": "1",
    "com.docker.compose.oneoff": "False",
    "com.docker.compose.project.working_dir": context.project.root,
    "com.docker.compose.project.config_files": context.project.composeFile
  };
  for (const [name, expected] of Object.entries(requiredLabels)) {
    if (labels[name] !== expected) {
      throw new Error(`Docker Compose container label ${name} does not match`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(String(labels["com.docker.compose.config-hash"] ?? ""))) {
    throw new Error("Docker Compose container config hash is invalid");
  }
  const bindings = container.HostConfig?.PortBindings;
  if (!bindings || Object.keys(bindings).length !== 1 || !Array.isArray(bindings["5432/tcp"]) || bindings["5432/tcp"].length !== 1 || bindings["5432/tcp"][0]?.HostIp !== context.publishedHost || String(bindings["5432/tcp"][0]?.HostPort ?? "") !== context.publishedPort) {
    throw new Error("Running postgres container port does not match the reviewed Compose binding");
  }
  const environment = normalizeEnvironment(container.Config?.Env);
  if (environment.POSTGRES_DB !== context.database || environment.POSTGRES_USER !== context.user || environment.POSTGRES_PASSWORD_FILE !== POSTGRES_PASSWORD_FILE || environment.POSTGRES_PASSWORD !== undefined) {
    throw new Error("Running postgres container environment does not match Compose");
  }
  const dataMounts = (Array.isArray(container.Mounts) ? container.Mounts : []).filter((entry) => entry?.Destination === POSTGRES_DATA_DIRECTORY);
  if (dataMounts.length !== 1 || dataMounts[0]?.Type !== "volume" || dataMounts[0]?.Name !== `${context.project.name}_saltanat-postgres` || dataMounts[0]?.RW !== true) {
    throw new Error("Running postgres container is not attached to the exact project volume");
  }
  const secretMounts = (Array.isArray(container.Mounts) ? container.Mounts : []).filter((entry) => entry?.Destination === POSTGRES_PASSWORD_FILE);
  if (secretMounts.length !== 1 || secretMounts[0]?.Type !== "bind" || secretMounts[0]?.Source !== context.secretSource || secretMounts[0]?.RW !== false) {
    throw new Error("Running postgres container is not attached to the exact reviewed password secret");
  }
  return { imageId: container.Image };
}

export function validateRecoveryHelperContainer(inspected, context) {
  if (!Array.isArray(inspected) || inspected.length !== 1) {
    throw new Error("Recovery helper inspection must return exactly one container");
  }
  const container = inspected[0];
  if (!container || container.Id !== context.containerId || container.Name !== `/${context.name}` || container.Image !== context.imageId || container.Config?.Image !== context.imageId) {
    throw new Error("Recovery helper container identity does not match");
  }
  if (
    container.State?.Status !== "created" ||
    container.State?.Running === true ||
    container.HostConfig?.NetworkMode !== `container:${context.sourceContainerId}` ||
    container.HostConfig?.ReadonlyRootfs !== true ||
    container.HostConfig?.AutoRemove !== true ||
    container.HostConfig?.Privileged === true ||
    container.HostConfig?.CapAdd?.length > 0 ||
    !Array.isArray(container.HostConfig?.CapDrop) ||
    !container.HostConfig.CapDrop.includes("ALL")
  ) {
    throw new Error("Recovery helper container isolation does not match");
  }
  const labels = container.Config?.Labels ?? {};
  if (Object.keys(context.labels).some((name) => labels[name] !== context.labels[name])) {
    throw new Error("Recovery helper container labels do not match");
  }
  const secretMounts = (Array.isArray(container.Mounts) ? container.Mounts : []).filter((entry) => entry?.Destination === POSTGRES_PASSWORD_FILE);
  if (secretMounts.length !== 1 || secretMounts[0]?.Type !== "bind" || secretMounts[0]?.Source !== context.secretSource || secretMounts[0]?.RW !== false) {
    throw new Error("Recovery helper password-secret mount does not match");
  }
  if (container.Config?.Entrypoint?.length !== 1 || container.Config.Entrypoint[0] !== "/bin/sh" || !Array.isArray(container.Config?.Cmd) || !container.Config.Cmd.includes(context.tool === "pg_dump" ? "/usr/bin/pg_dump" : "/usr/bin/pg_restore")) {
    throw new Error("Recovery helper container command does not match");
  }
  const environment = normalizeEnvironment(container.Config?.Env);
  if (environment.PGPASSWORD !== undefined) {
    throw new Error("Recovery helper container must not retain a password in inspectable environment");
  }
  for (const name of Object.keys(environment)) {
    if (name.startsWith("com.saltanatbotv2.") || name === "SALTANAT_RECOVERY_TOOL_RUN_ID") {
      throw new Error("Recovery helper leaked control metadata into its environment");
    }
  }
}

export function buildRecoveryToolPlan(tool, args, env, boundary) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    throw new Error("PostgreSQL recovery arguments must be strings");
  }
  if (args.length === 1 && args[0] === "--version") {
    return { toolArgs: ["--version"], connect: false };
  }
  if (tool === "pg_dump") {
    if (args.length !== 6 || args[0] !== "--format=custom" || args[1] !== "--no-owner" || args[2] !== "--no-privileges" || !/^--snapshot=[0-9A-Fa-f:-]{3,160}$/.test(args[3])) {
      throw new Error("pg_dump arguments are outside the project recovery contract");
    }
    const database = optionValue(args[4], "--dbname");
    if (database !== boundary.database || env.PGDATABASE !== boundary.database) {
      throw new Error("pg_dump may read only the exact Compose project database");
    }
    assertLocalConnectionEnvironment(env, boundary);
    return {
      toolArgs: args.slice(0, 5),
      outputPath: requiredAbsolutePath(optionValue(args[5], "--file"), "pg_dump output"),
      connect: true
    };
  }
  if (args.length === 2 && args[0] === "--list") {
    return {
      toolArgs: ["--list"],
      inputPath: requiredAbsolutePath(args[1], "pg_restore archive"),
      connect: false
    };
  }
  if (args.length !== 7 || args[0] !== "--exit-on-error" || args[1] !== "--single-transaction" || args[2] !== "--no-owner" || args[3] !== "--no-privileges") {
    throw new Error("pg_restore arguments are outside the project recovery contract");
  }
  const role = optionValue(args[4], "--role");
  const database = optionValue(args[5], "--dbname");
  requiredPostgresName(role, "pg_restore role");
  if (role !== boundary.user) {
    throw new Error("pg_restore role must be the exact Compose application role");
  }
  if (!isReplacementDatabase(boundary.database, database) || env.PGDATABASE !== database) {
    throw new Error("pg_restore may write only a project-owned restore or drill database");
  }
  assertLocalConnectionEnvironment(env, boundary);
  return {
    toolArgs: args.slice(0, 6),
    inputPath: requiredAbsolutePath(args[6], "pg_restore archive"),
    connect: true
  };
}

function cleanupRecoveryHelper({ capture, dockerBinary, dockerHost, env, expectedContainerId, now, project, requireQuiescence, runId, sleep, tool }) {
  const name = recoveryHelperName(project.name, tool, runId);
  const labels = recoveryHelperLabels({
    project,
    runId,
    sourceContainerId: undefined,
    tool
  });
  const filterArgs = [
    "--host",
    dockerHost,
    "container",
    "ls",
    "--all",
    "--quiet",
    "--no-trunc",
    "--filter",
    `name=^/${name}$`,
    "--filter",
    `label=com.saltanatbotv2.recovery-tool=true`,
    "--filter",
    `label=com.saltanatbotv2.recovery-project=${project.name}`,
    "--filter",
    `label=com.saltanatbotv2.recovery-run-id=${runId}`,
    "--filter",
    `label=com.saltanatbotv2.recovery-tool-name=${tool}`
  ];
  let absenceStartedAt = now();
  while (true) {
    const selected = containerIds(
      capture({
        command: dockerBinary,
        args: filterArgs,
        env,
        timeout: COMMAND_TIMEOUT_MS
      })
    );
    if (selected.length > 1) {
      throw new Error("Recovery helper cleanup matched multiple containers");
    }
    if (selected.length === 1) {
      if (expectedContainerId && selected[0] !== expectedContainerId) {
        throw new Error("Recovery helper cleanup found a different container identity");
      }
      removeExactRecoveryHelper({
        capture,
        containerId: selected[0],
        dockerBinary,
        dockerHost,
        env,
        labels,
        name,
        project
      });
      absenceStartedAt = now();
      if (!requireQuiescence) {
        const retained = containerIds(
          capture({
            command: dockerBinary,
            args: filterArgs,
            env,
            timeout: COMMAND_TIMEOUT_MS
          })
        );
        if (retained.length !== 0) {
          throw new Error("Recovery helper cleanup could not prove container removal");
        }
        return;
      }
    } else if (!requireQuiescence) {
      return;
    } else if (now() - absenceStartedAt >= CLEANUP_QUIESCENCE_MS) {
      return;
    }
    sleep(CLEANUP_POLL_MS);
  }
}

function removeExactRecoveryHelper({ capture, containerId, dockerBinary, dockerHost, env, labels, name, project }) {
  const inspected = parseJsonCapture(
    capture({
      command: dockerBinary,
      args: ["--host", dockerHost, "inspect", "--type", "container", containerId],
      env,
      timeout: COMMAND_TIMEOUT_MS
    }),
    "Recovery helper cleanup inspection"
  );
  const container = inspected?.[0];
  const sourceContainerId = container?.Config?.Labels?.["com.saltanatbotv2.recovery-source-container"];
  const secretSourceHash = container?.Config?.Labels?.["com.saltanatbotv2.recovery-secret-source-sha256"];
  const secretMounts = (Array.isArray(container?.Mounts) ? container.Mounts : []).filter((entry) => entry?.Destination === POSTGRES_PASSWORD_FILE);
  const mountedSecretSource = secretMounts[0]?.Source;
  if (
    !container ||
    container.Id !== containerId ||
    container.Name !== `/${name}` ||
    container.Config?.Labels?.["com.saltanatbotv2.recovery-tool"] !== labels["com.saltanatbotv2.recovery-tool"] ||
    container.Config?.Labels?.["com.saltanatbotv2.recovery-project"] !== labels["com.saltanatbotv2.recovery-project"] ||
    container.Config?.Labels?.["com.saltanatbotv2.recovery-run-id"] !== labels["com.saltanatbotv2.recovery-run-id"] ||
    container.Config?.Labels?.["com.saltanatbotv2.recovery-tool-name"] !== labels["com.saltanatbotv2.recovery-tool-name"] ||
    !/^[0-9a-f]{64}$/.test(String(sourceContainerId ?? "")) ||
    container.HostConfig?.NetworkMode !== `container:${sourceContainerId}` ||
    !/^sha256:[0-9a-f]{64}$/.test(String(container.Image ?? "")) ||
    container.Config?.Image !== container.Image ||
    container.Config?.Entrypoint?.[0] !== "/bin/sh" ||
    container.HostConfig?.ReadonlyRootfs !== true ||
    container.HostConfig?.AutoRemove !== true ||
    container.HostConfig?.Privileged === true ||
    secretMounts.length !== 1 ||
    secretMounts[0]?.Type !== "bind" ||
    secretMounts[0]?.RW !== false ||
    !/^[0-9a-f]{64}$/.test(String(secretSourceHash ?? "")) ||
    createHash("sha256")
      .update(String(mountedSecretSource ?? ""), "utf8")
      .digest("hex") !== secretSourceHash
  ) {
    throw new Error("Refusing cleanup of a container without the exact recovery helper identity");
  }
  requiredComposeSecretSource(mountedSecretSource);
  capture({
    command: dockerBinary,
    args: ["--host", dockerHost, "container", "rm", "--force", containerId],
    env,
    timeout: COMMAND_TIMEOUT_MS
  });
}

export function runDockerChild(command, args, options = {}, dependencies = {}) {
  const spawnImplementation = dependencies.spawn ?? spawn;
  const processLike = dependencies.process ?? process;
  return new Promise((resolve, reject) => {
    const child = spawnImplementation(command, args, {
      env: options.env,
      stdio: [options.stdin ?? "ignore", "pipe", "pipe"]
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputError;
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let forwardedSignal;
    const handlers = new Map();
    const cleanup = () => {
      for (const [signal, handler] of handlers) {
        processLike.removeListener(signal, handler);
      }
    };
    for (const signal of SIGNALS) {
      const handler = () => {
        forwardedSignal = signal;
        child.kill(signal);
      };
      handlers.set(signal, handler);
      processLike.once(signal, handler);
    }
    child.stdout?.on("data", (chunk) => {
      const value = Buffer.from(chunk);
      try {
        if (options.stdoutDescriptor !== undefined) {
          let offset = 0;
          while (offset < value.length) {
            const written = writeSync(options.stdoutDescriptor, value, offset, value.length - offset);
            if (written <= 0) throw new Error("Could not write pg_dump output");
            offset += written;
          }
          return;
        }
        stdoutBytes += value.length;
        if (stdoutBytes <= MAX_STDOUT_BYTES) stdoutChunks.push(value);
        else if (!stdoutOverflow) {
          stdoutOverflow = true;
          child.kill("SIGKILL");
        }
      } catch (error) {
        outputError = error;
        child.kill("SIGKILL");
      }
    });
    child.stderr?.on("data", (chunk) => {
      const value = Buffer.from(chunk);
      stderrBytes += value.length;
      if (stderrBytes <= MAX_STDERR_BYTES) stderrChunks.push(value);
      else if (!stderrOverflow) {
        stderrOverflow = true;
        child.kill("SIGKILL");
      }
    });
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      const stdout = redact(Buffer.concat(stdoutChunks).toString("utf8"), options.redactions);
      const stderr = redact(Buffer.concat(stderrChunks).toString("utf8"), options.redactions);
      if (stdout) options.stdout?.write(stdout);
      if (stderr) options.stderr?.write(stderr);
      if (outputError) {
        reject(outputError);
        return;
      }
      if (stdoutOverflow || stderrOverflow) {
        reject(new Error(`Docker PostgreSQL tool ${stdoutOverflow ? "stdout" : "stderr"} exceeded the safe limit`));
        return;
      }
      resolve({
        code: Number.isInteger(code) ? code : signal || forwardedSignal ? null : 1,
        signal: signal ?? forwardedSignal
      });
    });
  });
}

function createRecoveryHelper({ boundary, capture, containerId, containerImageId, dockerBinary, dockerHost, env, internalTimeoutSeconds, plan, project, recoveryGid, recoveryUid, runId, tool }) {
  const name = recoveryHelperName(project.name, tool, runId);
  const labels = recoveryHelperLabels({
    project,
    runId,
    secretSource: boundary.secretSource,
    sourceContainerId: containerId,
    tool
  });
  const args = [
    "--host",
    dockerHost,
    "create",
    "--name",
    name,
    "--rm",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    "64",
    "--memory",
    "268435456",
    "--cpus",
    "0.50",
    "--stop-timeout",
    "2",
    "--network",
    `container:${containerId}`,
    "--user",
    `${validateContainerAccountId(recoveryUid, "recovery uid")}:${validateContainerAccountId(recoveryGid, "recovery gid")}`,
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=16777216",
    "--mount",
    `type=bind,source=${boundary.secretSource},target=${POSTGRES_PASSWORD_FILE},readonly`
  ];
  if (plan.inputPath !== undefined) args.push("--interactive");
  for (const [label, value] of Object.entries(labels)) {
    args.push("--label", `${label}=${value}`);
  }
  const childEnvironment = dockerClientEnvironment(env);
  if (plan.connect) {
    const values = {
      PGDATABASE: env.PGDATABASE,
      PGUSER: env.PGUSER,
      PGCONNECT_TIMEOUT: normalizeConnectTimeout(env.PGCONNECT_TIMEOUT),
      PGAPPNAME: "saltanatbotv2-project-recovery-compose-wrapper"
    };
    Object.assign(childEnvironment, values);
    args.push("--env", "PGHOST=127.0.0.1");
    args.push("--env", "PGPORT=5432");
    args.push("--env", "PGSSLMODE=disable");
    for (const name of Object.keys(values)) {
      args.push("--env", name);
    }
  }
  args.push(
    "--entrypoint",
    "/bin/sh",
    containerImageId,
    "-ceu",
    `export PGPASSWORD="$(cat ${POSTGRES_PASSWORD_FILE})"; exec /usr/bin/timeout "$@"`,
    "saltanatbotv2-recovery-timeout",
    "--signal=TERM",
    "--kill-after=2s",
    `${internalTimeoutSeconds}s`,
    tool === "pg_dump" ? "/usr/bin/pg_dump" : "/usr/bin/pg_restore",
    ...plan.toolArgs
  );
  const helperContainerId = validateContainerId(
    capture({
      command: dockerBinary,
      args,
      env: childEnvironment,
      timeout: HELPER_CREATE_TIMEOUT_MS,
      redactions: plan.connect ? [env.PGPASSWORD] : []
    })
  );
  const inspected = parseJsonCapture(
    capture({
      command: dockerBinary,
      args: ["--host", dockerHost, "inspect", "--type", "container", helperContainerId],
      env: dockerClientEnvironment(env),
      timeout: COMMAND_TIMEOUT_MS
    }),
    "Recovery helper container inspection"
  );
  validateRecoveryHelperContainer(inspected, {
    containerId: helperContainerId,
    imageId: containerImageId,
    labels,
    name,
    secretSource: boundary.secretSource,
    sourceContainerId: containerId,
    tool
  });
  return {
    containerId: helperContainerId,
    name
  };
}

function buildDockerStartExecution({ dockerBinary, dockerHost, env, helper, opened }) {
  const args = ["--host", dockerHost, "start", "--attach"];
  if (opened?.kind === "input") args.push("--interactive");
  args.push(helper.containerId);
  return {
    command: dockerBinary,
    args,
    env: dockerClientEnvironment(env),
    stdin: opened?.kind === "input" ? opened.descriptor : "ignore"
  };
}

function validateDockerHost({ dockerBinary, dockerSocket }) {
  const binaryEntry = lstatSync(dockerBinary);
  if (binaryEntry.isSymbolicLink() || !binaryEntry.isFile() || binaryEntry.uid !== 0 || (binaryEntry.mode & 0o022) !== 0) {
    throw new Error("Docker CLI must be the reviewed root-owned, non-writable regular binary");
  }
  const socketEntry = statSync(dockerSocket);
  if (!socketEntry.isSocket() || socketEntry.uid !== 0) {
    throw new Error("Docker recovery wrapper requires the local root-owned Docker socket");
  }
}

function captureDockerCommand({ command, args, env, timeout, redactions }) {
  const result = spawnSync(command, args, {
    env,
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: MAX_CONFIG_BYTES
  });
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error("Docker identity check timed out");
  }
  if (result.error) {
    throw new Error(`Docker identity check could not start: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`Docker identity check was terminated by ${result.signal}`);
  }
  if (result.status !== 0) {
    const detail = redact(String(result.stderr || result.stdout || ""), redactions)
      .trim()
      .slice(0, 2_000);
    throw new Error(`Docker identity check failed with exit code ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return String(result.stdout ?? "").trim();
}

function validatePostgresToolVersions(versions, image) {
  const dump = postgresMajor(versions.pgDump, "pg_dump");
  const restore = postgresMajor(versions.pgRestore, "pg_restore");
  const imageMajor = Number(image.match(/^postgres:(\d+)\./)?.[1]);
  if (dump !== POSTGRES_MAJOR || restore !== POSTGRES_MAJOR || imageMajor !== POSTGRES_MAJOR) {
    throw new Error("Compose pg_dump, pg_restore and PostgreSQL image major versions do not match");
  }
}

function postgresMajor(value, label) {
  const match = String(value)
    .trim()
    .match(/^pg_(?:dump|restore) \(PostgreSQL\) (\d+)(?:\.|$)/);
  if (!match) throw new Error(`${label} returned an invalid version`);
  return Number(match[1]);
}

function openExclusiveDumpOutput(file) {
  const parent = path.dirname(file);
  assertNoSymlinkComponents(parent, "pg_dump output parent");
  const parentEntry = lstatSync(parent);
  const currentUid = process.getuid?.();
  if (parentEntry.isSymbolicLink() || !parentEntry.isDirectory() || (currentUid !== undefined && parentEntry.uid !== currentUid) || (parentEntry.mode & 0o022) !== 0) {
    throw new Error("pg_dump output parent must be a private recovery-operator directory");
  }
  if (existsSync(file)) throw new Error("pg_dump output already exists");
  const descriptor = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600);
  const entry = fstatSync(descriptor);
  if (!entry.isFile()) {
    closeSync(descriptor);
    throw new Error("pg_dump output is not a regular file");
  }
  return {
    kind: "output",
    path: file,
    descriptor,
    identity: filesystemIdentity(entry)
  };
}

function openVerifiedDumpInput(file) {
  assertNoSymlinkComponents(path.dirname(file), "pg_restore archive parent");
  const pathEntry = lstatSync(file);
  const currentUid = process.getuid?.();
  if (pathEntry.isSymbolicLink() || !pathEntry.isFile() || pathEntry.size <= 0 || (currentUid !== undefined && pathEntry.uid !== currentUid) || (pathEntry.mode & 0o022) !== 0) {
    throw new Error("pg_restore archive must be a private operator-owned file");
  }
  const descriptor = openSync(file, constants.O_RDONLY | noFollowFlag());
  const entry = fstatSync(descriptor);
  if (!entry.isFile() || entry.dev !== pathEntry.dev || entry.ino !== pathEntry.ino || entry.size !== pathEntry.size) {
    closeSync(descriptor);
    throw new Error("pg_restore archive changed while it was opened");
  }
  return {
    kind: "input",
    path: file,
    descriptor,
    identity: filesystemIdentity(entry)
  };
}

function assertOpenFileIdentity(opened, label) {
  const descriptorEntry = opened.descriptor === undefined ? undefined : fstatSync(opened.descriptor);
  const pathEntry = lstatSync(opened.path);
  if (pathEntry.isSymbolicLink() || !pathEntry.isFile() || !sameIdentity(pathEntry, opened.identity) || (descriptorEntry !== undefined && !sameIdentity(descriptorEntry, opened.identity))) {
    throw new Error(`${label} identity changed during Docker execution`);
  }
}

function closeOpenedFile(opened) {
  if (opened.descriptor === undefined) return;
  closeSync(opened.descriptor);
  opened.descriptor = undefined;
}

function safeRemoveOutput(opened) {
  if (!existsSync(opened.path)) return;
  const entry = lstatSync(opened.path);
  if (entry.isSymbolicLink() || !entry.isFile() || !sameIdentity(entry, opened.identity)) {
    throw new Error("Refusing to remove pg_dump output after its identity changed");
  }
  unlinkSync(opened.path);
}

function assertLocalConnectionEnvironment(env, boundary) {
  if (env.PGHOST !== boundary.publishedHost || String(env.PGPORT ?? "") !== boundary.publishedPort) {
    throw new Error("PostgreSQL recovery connection must match the exact loopback Compose port");
  }
  if (requiredPostgresName(env.PGUSER, "PGUSER") !== boundary.user) {
    throw new Error("PGUSER must be the exact Compose PostgreSQL application role");
  }
  if (typeof env.PGPASSWORD !== "string" || env.PGPASSWORD.length === 0 || env.PGPASSWORD.includes("\0")) {
    throw new Error("PGPASSWORD is required by the Compose recovery wrapper");
  }
  assertPasswordMatchesSecret(env.PGPASSWORD, boundary.secretSource);
}

function normalizeConnectTimeout(value) {
  const selected = value === undefined ? "10" : String(value);
  if (!/^\d+$/.test(selected) || Number(selected) < 1 || Number(selected) > 30) {
    throw new Error("PGCONNECT_TIMEOUT must be between 1 and 30 seconds");
  }
  return selected;
}

function isReplacementDatabase(source, candidate) {
  requiredPostgresName(candidate, "replacement database");
  return candidate.startsWith(`${source}_restore_`) || candidate.startsWith(`${source}_drill_`);
}

function requiredPostgresName(value, label) {
  const selected = String(value ?? "");
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(selected) || Buffer.byteLength(selected, "utf8") > 63) {
    throw new Error(`${label} must be a lower-case PostgreSQL name`);
  }
  return selected;
}

function optionValue(argument, name) {
  const prefix = `${name}=`;
  if (!argument.startsWith(prefix) || argument.length === prefix.length) {
    throw new Error(`${name} must use the reviewed inline form`);
  }
  return argument.slice(prefix.length);
}

function requiredAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  return value;
}

function requiredComposeSecretSource(value) {
  const selected = requiredAbsolutePath(String(value ?? ""), "Compose postgres password secret");
  assertNoSymlinkComponents(path.dirname(selected), "Compose postgres password secret parent");
  const entry = lstatSync(selected);
  const currentUid = process.getuid?.();
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1 || entry.size <= 0 || entry.size > MAX_PASSWORD_BYTES || (currentUid !== undefined && entry.uid !== currentUid) || ![0o400, 0o600].includes(entry.mode & 0o777)) {
    throw new Error("Compose postgres password secret must be a private operator-owned regular file");
  }
  return selected;
}

function assertPasswordMatchesSecret(password, file) {
  const descriptor = openSync(file, constants.O_RDONLY | noFollowFlag());
  let material;
  let provided;
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || ![0o400, 0o600].includes(before.mode & 0o777) || before.size > MAX_PASSWORD_BYTES) {
      throw new Error("Compose postgres password secret changed");
    }
    material = Buffer.alloc(Number(before.size) + 1);
    const bytesRead = readSync(descriptor, material, 0, material.length, 0);
    if (bytesRead !== before.size) {
      throw new Error("Compose postgres password secret changed while reading");
    }
    const selected = material
      .subarray(0, bytesRead)
      .toString("utf8")
      .replace(/\r?\n$/, "");
    provided = Buffer.from(password, "utf8");
    const expected = Buffer.from(selected, "utf8");
    const matches = provided.length === expected.length && timingSafeEqual(provided, expected);
    expected.fill(0);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(file);
    if (
      !sameIdentity(after, filesystemIdentity(before)) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.nlink !== after.nlink ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      pathAfter.nlink !== 1 ||
      !sameIdentity(pathAfter, filesystemIdentity(before)) ||
      pathAfter.size !== before.size ||
      pathAfter.mtimeMs !== before.mtimeMs ||
      pathAfter.ctimeMs !== before.ctimeMs ||
      (pathAfter.mode & 0o777) !== (before.mode & 0o777)
    ) {
      throw new Error("Compose postgres password secret changed while reading");
    }
    if (!matches) {
      throw new Error("PGPASSWORD does not match the exact Compose postgres secret");
    }
  } finally {
    material?.fill(0);
    provided?.fill(0);
    closeSync(descriptor);
  }
}

function validateContainerId(value) {
  const lines = String(value).trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1 || !/^[0-9a-f]{64}$/.test(lines[0])) {
    throw new Error("Docker Compose must resolve exactly one full postgres container ID");
  }
  return lines[0];
}

function containerIds(value) {
  const lines = String(value).trim().split(/\r?\n/).filter(Boolean);
  if (lines.some((entry) => !/^[0-9a-f]{64}$/.test(entry))) {
    throw new Error("Docker returned an invalid recovery helper container ID");
  }
  return lines;
}

function cleanupRunIdFromArguments(args) {
  if (args.length === 1 && typeof args[0] === "string" && args[0].startsWith("--cleanup-run=")) {
    return requiredRunId(args[0].slice("--cleanup-run=".length));
  }
  return undefined;
}

function requiredRunId(value) {
  const selected = String(value ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(selected)) {
    throw new Error("SALTANAT_RECOVERY_TOOL_RUN_ID must be an exact lowercase UUID v4");
  }
  return selected;
}

function recoveryInternalTimeoutSeconds(value) {
  const selected = String(value ?? "");
  if (!/^\d+$/.test(selected)) {
    throw new Error("SALTANAT_RECOVERY_TOOL_TIMEOUT_MS must be an integer");
  }
  const milliseconds = Number(selected);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 10_000 || milliseconds > 3_600_000) {
    throw new Error("SALTANAT_RECOVERY_TOOL_TIMEOUT_MS must be between 10000 and 3600000");
  }
  return Math.max(5, Math.floor(milliseconds / 1_000) - 5);
}

function recoveryHelperName(projectName, tool, runId) {
  const suffix = runId.replaceAll("-", "");
  const name = `${projectName}-recovery-${tool.replace("_", "-")}-${suffix}`;
  if (name.length > 128 || !/^[a-z0-9][a-z0-9_.-]+$/.test(name)) {
    throw new Error("Recovery helper container name is invalid");
  }
  return name;
}

function recoveryHelperLabels({ project, runId, secretSource, sourceContainerId, tool }) {
  return {
    "com.saltanatbotv2.recovery-tool": "true",
    "com.saltanatbotv2.recovery-project": project.name,
    "com.saltanatbotv2.recovery-run-id": runId,
    "com.saltanatbotv2.recovery-tool-name": tool,
    ...(secretSource
      ? {
          "com.saltanatbotv2.recovery-secret-source-sha256": createHash("sha256").update(secretSource, "utf8").digest("hex")
        }
      : {}),
    ...(sourceContainerId
      ? {
          "com.saltanatbotv2.recovery-source-container": sourceContainerId
        }
      : {})
  };
}

function validateContainerAccountId(value, label) {
  const selected = String(value).trim();
  if (!/^\d+$/.test(selected)) {
    throw new Error(`${label} is invalid`);
  }
  const numeric = Number(selected);
  if (!Number.isSafeInteger(numeric) || numeric < 1 || numeric > 65_535) {
    throw new Error(`${label} is outside the safe range`);
  }
  return selected;
}

function normalizeEnvironment(value) {
  const entries = Array.isArray(value)
    ? value.map((entry) => {
        const separator = String(entry).indexOf("=");
        return separator < 0 ? [String(entry), ""] : [String(entry).slice(0, separator), String(entry).slice(separator + 1)];
      })
    : Object.entries(value ?? {}).map(([name, entry]) => [name, entry === null || entry === undefined ? "" : String(entry)]);
  const result = {};
  for (const [name, entry] of entries) {
    if (Object.hasOwn(result, name)) {
      throw new Error(`Duplicate environment variable ${name}`);
    }
    result[name] = entry;
  }
  return result;
}

function dockerClientEnvironment(env) {
  const allowed = ["HOME", "PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE"];
  return Object.fromEntries(allowed.flatMap((name) => (env[name] === undefined ? [] : [[name, String(env[name])]])));
}

function parseJsonCapture(value, label) {
  if (Buffer.byteLength(String(value), "utf8") > MAX_CONFIG_BYTES) {
    throw new Error(`${label} is too large`);
  }
  try {
    return JSON.parse(String(value));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function normalizeComposeProjectName(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "")
    .replace(/^[^a-z0-9]+/, "");
}

function assertPrivateProjectFile(file, label) {
  assertNoSymlinkComponents(path.dirname(file), `${label} parent`);
  const entry = lstatSync(file);
  const currentUid = process.getuid?.();
  if (entry.isSymbolicLink() || !entry.isFile() || (currentUid !== undefined && entry.uid !== currentUid) || (entry.mode & 0o022) !== 0) {
    throw new Error(`${label} must be a private regular file owned by the recovery operator`);
  }
  return entry;
}

function assertNoSymlinkComponents(absolutePath, label) {
  if (!path.isAbsolute(absolutePath)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const parsed = path.parse(absolutePath);
  let current = parsed.root;
  for (const component of absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const entry = lstatSync(current);
    if (entry.isSymbolicLink()) {
      throw new Error(`${label} must not contain symbolic-link components`);
    }
  }
}

function filesystemIdentity(entry) {
  return {
    dev: entry.dev,
    ino: entry.ino,
    uid: entry.uid
  };
}

function sameIdentity(entry, identity) {
  return entry.dev === identity.dev && entry.ino === identity.ino && entry.uid === identity.uid;
}

function noFollowFlag() {
  return "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
}

function isPort(value) {
  return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65_535;
}

function synchronousSleep(milliseconds) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function redact(value, redactions = []) {
  let result = String(value);
  for (const material of redactions) {
    if (typeof material === "string" && material.length > 0) {
      result = result.replaceAll(material, "[redacted]");
    }
  }
  return result;
}
