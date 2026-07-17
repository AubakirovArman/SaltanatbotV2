import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runComposePostgresRecoveryTool, runDockerChild } from "../../scripts/lib/compose-postgres-recovery-tool.mjs";

const temporaryDirectories: string[] = [];
const runId = "11111111-1111-4111-8111-111111111111";
const sourceContainerId = "a".repeat(64);
const helperContainerId = "b".repeat(64);
const imageId = `sha256:${"c".repeat(64)}`;
const password = "unit-only-compose-password";

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("safe Compose PostgreSQL recovery wrappers", () => {
  it("streams pg_dump from an isolated exact-image helper without exposing the password", async () => {
    const fixture = createFixture();
    const output = path.resolve(fixture.privateOutput, "postgres.dump");
    const fake = fakeDocker(fixture);

    const result = await runComposePostgresRecoveryTool("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--snapshot=00000003-0000001B-1", "--dbname=saltanatbotv2", `--file=${output}`], {
      projectRoot: fixture.root,
      cwd: fixture.root,
      env: recoveryEnvironment(),
      dependencies: {
        validateDockerHost: vi.fn(),
        capture: fake.capture,
        runChild: async (_command: string, args: string[], options: { stdoutDescriptor?: number }) => {
          fake.startedArgs = args;
          writeSync(options.stdoutDescriptor!, Buffer.from("PGDMP-safe-unit-archive"));
          return { code: 0, signal: null };
        }
      }
    });

    expect(result).toEqual({ code: 0, signal: null });
    expect(readFileSync(output, "utf8")).toBe("PGDMP-safe-unit-archive");
    expect(fake.createArgs.join("\0")).not.toContain(password);
    expect(JSON.stringify(fake.helperInspection)).not.toContain(password);
    expect(fake.createArgs).toContain(`container:${sourceContainerId}`);
    expect(fake.createArgs).toContain(imageId);
    expect(fake.createArgs).toContain("--read-only");
    expect(fake.createArgs).toContain("no-new-privileges:true");
    expect(fake.startedArgs).toEqual(["--host", "unix:///var/run/docker.sock", "start", "--attach", helperContainerId]);
    expect(fake.removedIds).toEqual([helperContainerId]);
    expect(fake.helperExists).toBe(false);
  });

  it("streams a private archive through stdin only into a project-owned restore database", async () => {
    const fixture = createFixture();
    const archive = path.resolve(fixture.privateOutput, "postgres.dump");
    writeFileSync(archive, "PGDMP-safe-unit-archive", { mode: 0o600 });
    chmodSync(archive, 0o600);
    const fake = fakeDocker(fixture);
    let received:
      | {
          args: string[];
          stdin: number | string;
        }
      | undefined;

    await runComposePostgresRecoveryTool("pg_restore", ["--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges", "--role=saltanatbotv2", "--dbname=saltanatbotv2_restore_unit", archive], {
      projectRoot: fixture.root,
      cwd: fixture.root,
      env: recoveryEnvironment({
        PGDATABASE: "saltanatbotv2_restore_unit"
      }),
      dependencies: {
        validateDockerHost: vi.fn(),
        capture: fake.capture,
        runChild: async (_command: string, args: string[], options: { stdin: number | string }) => {
          received = { args, stdin: options.stdin };
          return { code: 0, signal: null };
        }
      }
    });

    expect(received?.args).toEqual(["--host", "unix:///var/run/docker.sock", "start", "--attach", "--interactive", helperContainerId]);
    expect(typeof received?.stdin).toBe("number");
    expect(fake.createArgs).toContain("--interactive");
    expect(fake.createArgs.at(-1)).toBe("--dbname=saltanatbotv2_restore_unit");
    expect(fake.createArgs).not.toContain("-");
    expect(fake.createArgs.join("\0")).not.toContain(archive);
    expect(fake.createArgs.join("\0")).not.toContain(password);
    expect(fake.removedIds).toEqual([helperContainerId]);
  });

  it("lists a private archive through stdin without treating a dash as a filename", async () => {
    const fixture = createFixture();
    const archive = path.resolve(fixture.privateOutput, "postgres.dump");
    writeFileSync(archive, "PGDMP-safe-unit-archive", { mode: 0o600 });
    chmodSync(archive, 0o600);
    const fake = fakeDocker(fixture);
    let received:
      | {
          args: string[];
          stdin: number | string;
        }
      | undefined;

    await runComposePostgresRecoveryTool("pg_restore", ["--list", archive], {
      projectRoot: fixture.root,
      cwd: fixture.root,
      env: recoveryEnvironment(),
      dependencies: {
        validateDockerHost: vi.fn(),
        capture: fake.capture,
        runChild: async (_command: string, args: string[], options: { stdin: number | string }) => {
          received = { args, stdin: options.stdin };
          return { code: 0, signal: null };
        }
      }
    });

    expect(received?.args).toEqual(["--host", "unix:///var/run/docker.sock", "start", "--attach", "--interactive", helperContainerId]);
    expect(typeof received?.stdin).toBe("number");
    expect(fake.createArgs).toContain("--interactive");
    expect(fake.createArgs.at(-1)).toBe("--list");
    expect(fake.createArgs).not.toContain("-");
    expect(fake.createArgs.join("\0")).not.toContain(archive);
    expect(fake.removedIds).toEqual([helperContainerId]);
  });

  it("rejects a different project container identity before creating a helper", async () => {
    const fixture = createFixture();
    const output = path.resolve(fixture.privateOutput, "postgres.dump");
    const fake = fakeDocker(fixture, {
      mutateSourceInspection: (inspection) => {
        inspection[0].Config.Labels["com.docker.compose.project"] = "foreign-project";
      }
    });

    await expect(
      runComposePostgresRecoveryTool("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--snapshot=00000003-0000001B-1", "--dbname=saltanatbotv2", `--file=${output}`], {
        projectRoot: fixture.root,
        cwd: fixture.root,
        env: recoveryEnvironment(),
        dependencies: {
          validateDockerHost: vi.fn(),
          capture: fake.capture,
          runChild: vi.fn()
        }
      })
    ).rejects.toThrow(/exact Compose postgres service/i);
    expect(fake.createArgs).toEqual([]);
  });

  it("rejects a group-writable checkout or hard-linked password secret", async () => {
    const groupWritable = createFixture();
    chmodSync(groupWritable.root, 0o770);
    await expect(
      runComposePostgresRecoveryTool("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--snapshot=00000003-0000001B-1", "--dbname=saltanatbotv2", `--file=${path.resolve(groupWritable.privateOutput, "dump")}`], {
        projectRoot: groupWritable.root,
        cwd: groupWritable.root,
        env: recoveryEnvironment(),
        dependencies: {
          validateDockerHost: vi.fn(),
          capture: vi.fn(),
          runChild: vi.fn()
        }
      })
    ).rejects.toThrow(/group or world writable/i);

    const linkedSecret = createFixture();
    linkSync(linkedSecret.secretFile, path.resolve(path.dirname(linkedSecret.secretFile), "password-alias"));
    const fake = fakeDocker(linkedSecret);
    await expect(
      runComposePostgresRecoveryTool("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--snapshot=00000003-0000001B-1", "--dbname=saltanatbotv2", `--file=${path.resolve(linkedSecret.privateOutput, "dump")}`], {
        projectRoot: linkedSecret.root,
        cwd: linkedSecret.root,
        env: recoveryEnvironment(),
        dependencies: {
          validateDockerHost: vi.fn(),
          capture: fake.capture,
          runChild: vi.fn()
        }
      })
    ).rejects.toThrow(/private operator-owned regular file/i);
  });

  it("rejects a foreign host port, database, role or password before tool execution", async () => {
    const fixture = createFixture();
    const archive = path.resolve(fixture.privateOutput, "postgres.dump");
    writeFileSync(archive, "PGDMP-safe-unit-archive", { mode: 0o600 });
    const cases = [recoveryEnvironment({ PGPORT: "55435" }), recoveryEnvironment({ PGDATABASE: "foreign" }), recoveryEnvironment({ PGUSER: "foreign_role" }), recoveryEnvironment({ PGPASSWORD: "wrong-password" })];

    for (const env of cases) {
      const fake = fakeDocker(fixture);
      await expect(
        runComposePostgresRecoveryTool("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--snapshot=00000003-0000001B-1", "--dbname=saltanatbotv2", `--file=${path.resolve(fixture.privateOutput, "refused.dump")}`], {
          projectRoot: fixture.root,
          cwd: fixture.root,
          env,
          dependencies: {
            validateDockerHost: vi.fn(),
            capture: fake.capture,
            runChild: vi.fn()
          }
        })
      ).rejects.toThrow();
      expect(fake.createArgs).toEqual([]);
    }

    const fake = fakeDocker(fixture);
    await expect(
      runComposePostgresRecoveryTool("pg_restore", ["--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges", "--role=foreign_role", "--dbname=saltanatbotv2_restore_unit", archive], {
        projectRoot: fixture.root,
        cwd: fixture.root,
        env: recoveryEnvironment({
          PGDATABASE: "saltanatbotv2_restore_unit"
        }),
        dependencies: {
          validateDockerHost: vi.fn(),
          capture: fake.capture,
          runChild: vi.fn()
        }
      })
    ).rejects.toThrow(/exact Compose application role/);
    expect(fake.createArgs).toEqual([]);
  });

  it("removes only an exact labeled helper and refuses a same-name foreign container", async () => {
    const fixture = createFixture();
    const exact = fakeDocker(fixture, { helperInitiallyExists: true });
    let exactClock = 0;

    await expect(
      runComposePostgresRecoveryTool("pg_dump", [`--cleanup-run=${runId}`], {
        projectRoot: fixture.root,
        cwd: fixture.root,
        env: recoveryEnvironment(),
        dependencies: {
          validateDockerHost: vi.fn(),
          capture: exact.capture,
          runChild: vi.fn(),
          now: () => exactClock,
          sleep: (milliseconds: number) => {
            exactClock += milliseconds;
          }
        }
      })
    ).resolves.toEqual({ code: 0, signal: null });
    expect(exact.removedIds).toEqual([helperContainerId]);

    const foreign = fakeDocker(fixture, {
      helperInitiallyExists: true,
      mutateHelperInspection: (inspection) => {
        inspection[0].Config.Labels["com.saltanatbotv2.recovery-run-id"] = "22222222-2222-4222-8222-222222222222";
      }
    });
    let foreignClock = 0;
    await expect(
      runComposePostgresRecoveryTool("pg_dump", [`--cleanup-run=${runId}`], {
        projectRoot: fixture.root,
        cwd: fixture.root,
        env: recoveryEnvironment(),
        dependencies: {
          validateDockerHost: vi.fn(),
          capture: foreign.capture,
          runChild: vi.fn(),
          now: () => foreignClock,
          sleep: (milliseconds: number) => {
            foreignClock += milliseconds;
          }
        }
      })
    ).rejects.toThrow(/refusing cleanup/i);
    expect(foreign.removedIds).toEqual([]);
  });

  it("waits through cleanup quiescence and removes a helper that appears after the first empty poll", async () => {
    const fixture = createFixture();
    const late = fakeDocker(fixture);
    let clock = 0;
    let sleeps = 0;

    await expect(
      runComposePostgresRecoveryTool("pg_dump", [`--cleanup-run=${runId}`], {
        projectRoot: fixture.root,
        cwd: fixture.root,
        env: recoveryEnvironment(),
        dependencies: {
          validateDockerHost: vi.fn(),
          capture: late.capture,
          runChild: vi.fn(),
          now: () => clock,
          sleep: (milliseconds: number) => {
            clock += milliseconds;
            sleeps += 1;
            if (sleeps === 1) late.setHelperExists(true);
          }
        }
      })
    ).resolves.toEqual({ code: 0, signal: null });

    expect(late.removedIds).toEqual([helperContainerId]);
    expect(clock).toBeGreaterThanOrEqual(7_500);
    expect(late.helperExists).toBe(false);
  });

  it("forwards termination to Docker and redacts bounded diagnostic output", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    const processLike = new EventEmitter();
    const stderr: string[] = [];
    const promise = runDockerChild(
      "/usr/bin/docker",
      ["start", "--attach", helperContainerId],
      {
        env: { PGPASSWORD: password },
        stderr: { write: (value: string) => stderr.push(value) },
        stdout: { write: vi.fn() },
        redactions: [password]
      },
      {
        spawn: () => child,
        process: processLike
      }
    );

    child.stderr.write(`failure near ${password}\n`);
    processLike.emit("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, null);

    await expect(promise).resolves.toEqual({
      code: null,
      signal: "SIGTERM"
    });
    expect(stderr.join("")).toBe("failure near [redacted]\n");
  });
});

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "saltanat-compose-recovery-"));
  const secretDirectory = mkdtempSync(path.join(tmpdir(), "saltanat-compose-secret-"));
  temporaryDirectories.push(root, secretDirectory);
  const secretFile = path.resolve(secretDirectory, "postgres_password");
  const privateOutput = path.resolve(root, "recovery-output");
  mkdirSync(privateOutput, { mode: 0o700 });
  writeFileSync(
    path.resolve(root, "package.json"),
    JSON.stringify({
      name: "saltanatbotv2",
      private: true,
      type: "module"
    }),
    { mode: 0o600 }
  );
  writeFileSync(path.resolve(root, "docker-compose.yml"), "services: {}\n", {
    mode: 0o600
  });
  writeFileSync(secretFile, `${password}\n`, { mode: 0o600 });
  chmodSync(secretFile, 0o600);
  return {
    root,
    name: path
      .basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, ""),
    secretFile,
    privateOutput
  };
}

function recoveryEnvironment(overrides: Record<string, string> = {}) {
  return {
    HOME: process.env.HOME ?? "/tmp",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    PGHOST: "127.0.0.1",
    PGPORT: "55434",
    PGDATABASE: "saltanatbotv2",
    PGUSER: "saltanatbotv2",
    PGPASSWORD: password,
    PGCONNECT_TIMEOUT: "10",
    SALTANAT_RECOVERY_TOOL_RUN_ID: runId,
    SALTANAT_RECOVERY_TOOL_TIMEOUT_MS: "60000",
    ...overrides
  };
}

function fakeDocker(
  fixture: ReturnType<typeof createFixture>,
  options: {
    helperInitiallyExists?: boolean;
    mutateSourceInspection?: (inspection: any[]) => void;
    mutateHelperInspection?: (inspection: any[]) => void;
  } = {}
) {
  let helperExists = options.helperInitiallyExists ?? false;
  let helperInspection = makeHelperInspection(fixture);
  if (helperExists) options.mutateHelperInspection?.(helperInspection);
  const sourceInspection = makeSourceInspection(fixture);
  options.mutateSourceInspection?.(sourceInspection);
  const state = {
    createArgs: [] as string[],
    startedArgs: [] as string[],
    removedIds: [] as string[],
    helperInspection,
    get helperExists() {
      return helperExists;
    },
    setHelperExists(value: boolean) {
      helperExists = value;
    },
    capture: vi.fn(
      ({
        args,
        env
      }: {
        args: string[];
        env: Record<string, string>;
      }) => {
        if (args.includes("config") && args.includes("--format")) {
          return JSON.stringify(makeComposeConfig(fixture));
        }
        if (args.includes("compose") && args.includes("ps")) {
          return sourceContainerId;
        }
        if (args.includes("exec") && args.includes("/usr/bin/pg_dump")) {
          return "pg_dump (PostgreSQL) 17.10";
        }
        if (args.includes("exec") && args.includes("/usr/bin/pg_restore")) {
          return "pg_restore (PostgreSQL) 17.10";
        }
        if (args.includes("create")) {
          state.createArgs = [...args];
          expect(env.PGPASSWORD).toBeUndefined();
          helperExists = true;
          helperInspection = makeHelperInspection(fixture, args);
          state.helperInspection = helperInspection;
          return helperContainerId;
        }
        if (args.includes("inspect")) {
          const id = args.at(-1);
          if (id === sourceContainerId) return JSON.stringify(sourceInspection);
          if (id === helperContainerId && helperExists) {
            return JSON.stringify(helperInspection);
          }
          throw new Error("unexpected inspect target");
        }
        if (args.includes("container") && args.includes("ls")) {
          if (args.some((entry) => entry.includes("com.docker.compose.service=postgres"))) {
            return sourceContainerId;
          }
          return helperExists ? helperContainerId : "";
        }
        if (args.includes("container") && args.includes("rm")) {
          expect(args.at(-1)).toBe(helperContainerId);
          state.removedIds.push(helperContainerId);
          helperExists = false;
          return helperContainerId;
        }
        throw new Error(`Unexpected mocked Docker arguments: ${args.join(" ")}`);
      }
    )
  };
  return state;
}

function makeComposeConfig(fixture: ReturnType<typeof createFixture>) {
  return {
    name: fixture.name,
    services: {
      postgres: {
        image: "postgres:17.10-bookworm",
        ports: [
          {
            host_ip: "127.0.0.1",
            target: 5432,
            published: "55434",
            protocol: "tcp"
          }
        ],
        environment: {
          POSTGRES_DB: "saltanatbotv2",
          POSTGRES_USER: "saltanatbotv2",
          POSTGRES_PASSWORD_FILE: "/run/secrets/postgres_password"
        },
        volumes: [
          {
            type: "volume",
            source: "saltanat-postgres",
            target: "/var/lib/postgresql/data"
          }
        ]
      }
    },
    secrets: {
      postgres_password: {
        file: fixture.secretFile
      }
    }
  };
}

function makeSourceInspection(fixture: ReturnType<typeof createFixture>) {
  return [
    {
      Id: sourceContainerId,
      Name: `/${fixture.name}-postgres-1`,
      Image: imageId,
      State: {
        Status: "running",
        Running: true,
        Paused: false,
        Restarting: false,
        Dead: false,
        Health: { Status: "healthy" }
      },
      Config: {
        Image: "postgres:17.10-bookworm",
        Env: ["POSTGRES_DB=saltanatbotv2", "POSTGRES_USER=saltanatbotv2", "POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password"],
        Labels: {
          "com.docker.compose.project": fixture.name,
          "com.docker.compose.service": "postgres",
          "com.docker.compose.container-number": "1",
          "com.docker.compose.oneoff": "False",
          "com.docker.compose.project.working_dir": fixture.root,
          "com.docker.compose.project.config_files": path.resolve(fixture.root, "docker-compose.yml"),
          "com.docker.compose.config-hash": "d".repeat(64)
        }
      },
      HostConfig: {
        PortBindings: {
          "5432/tcp": [
            {
              HostIp: "127.0.0.1",
              HostPort: "55434"
            }
          ]
        }
      },
      Mounts: [
        {
          Type: "volume",
          Name: `${fixture.name}_saltanat-postgres`,
          Destination: "/var/lib/postgresql/data",
          RW: true
        },
        {
          Type: "bind",
          Source: fixture.secretFile,
          Destination: "/run/secrets/postgres_password",
          RW: false
        }
      ]
    }
  ];
}

function makeHelperInspection(fixture: ReturnType<typeof createFixture>, createArgs: string[] = []) {
  const labels: Record<string, string> = {
    "com.saltanatbotv2.recovery-tool": "true",
    "com.saltanatbotv2.recovery-project": fixture.name,
    "com.saltanatbotv2.recovery-run-id": runId,
    "com.saltanatbotv2.recovery-tool-name": "pg_dump",
    "com.saltanatbotv2.recovery-source-container": sourceContainerId,
    "com.saltanatbotv2.recovery-secret-source-sha256": createHash("sha256").update(fixture.secretFile, "utf8").digest("hex")
  };
  for (let index = 0; index < createArgs.length; index += 1) {
    if (createArgs[index] !== "--label") continue;
    const [name, ...value] = createArgs[index + 1]!.split("=");
    labels[name!] = value.join("=");
  }
  const nameIndex = createArgs.indexOf("--name");
  const name = nameIndex >= 0 ? createArgs[nameIndex + 1]! : `${fixture.name}-recovery-pg-dump-${runId.replaceAll("-", "")}`;
  const tool = labels["com.saltanatbotv2.recovery-tool-name"]!;
  return [
    {
      Id: helperContainerId,
      Name: `/${name}`,
      Image: imageId,
      State: {
        Status: "created",
        Running: false
      },
      Config: {
        Image: imageId,
        Entrypoint: ["/bin/sh"],
        Cmd: ["-ceu", "exec /usr/bin/timeout", tool === "pg_dump" ? "/usr/bin/pg_dump" : "/usr/bin/pg_restore"],
        Env: ["PGHOST=127.0.0.1", "PGPORT=5432", "PGDATABASE=saltanatbotv2"],
        Labels: labels
      },
      HostConfig: {
        NetworkMode: `container:${sourceContainerId}`,
        ReadonlyRootfs: true,
        AutoRemove: true,
        Privileged: false,
        CapAdd: [],
        CapDrop: ["ALL"]
      },
      Mounts: [
        {
          Type: "bind",
          Source: fixture.secretFile,
          Destination: "/run/secrets/postgres_password",
          RW: false
        }
      ]
    }
  ];
}
