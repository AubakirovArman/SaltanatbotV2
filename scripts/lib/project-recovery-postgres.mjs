import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const { Client } = pg;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = "55434";
const DEFAULT_DATABASE = "saltanatbotv2";
const DEFAULT_USER = "saltanatbotv2";
const DEFAULT_MAINTENANCE_DATABASE = "postgres";
const MAX_PASSWORD_BYTES = 8 * 1024;
const ONBOARDING_SCHEMA_VERSION = 11;
const EXECUTOR_COMMANDS_SCHEMA_VERSION = 12;

export function resolveRecoveryConnections(env = process.env) {
  const source = connectionFromEnvironment(env, {
    urlNames: ["RECOVERY_SOURCE_DATABASE_URL", "DATABASE_URL"],
    prefix: "PG",
    fallbacks: {
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      database: DEFAULT_DATABASE,
      user: DEFAULT_USER
    }
  });
  const operatorUrl = firstText(env.RECOVERY_OPERATOR_DATABASE_URL);
  const hasOperatorParameters = ["RECOVERY_OPERATOR_PGHOST", "RECOVERY_OPERATOR_PGPORT", "RECOVERY_OPERATOR_PGUSER", "RECOVERY_OPERATOR_PGPASSWORD", "RECOVERY_OPERATOR_PGPASSWORD_FILE", "RECOVERY_OPERATOR_PGSSLMODE"].some((name) => firstText(env[name]) !== undefined);
  const maintenanceDatabase = requiredName(env.RECOVERY_MAINTENANCE_DATABASE, operatorUrl ? databaseNameFromUrl(operatorUrl) : DEFAULT_MAINTENANCE_DATABASE, "RECOVERY_MAINTENANCE_DATABASE");
  const operator = operatorUrl
    ? connectionFromUrl(operatorUrl, env, "RECOVERY_OPERATOR_DATABASE_URL")
    : hasOperatorParameters
      ? connectionFromEnvironment(env, {
          prefix: "RECOVERY_OPERATOR_PG",
          fallbacks: {
            host: source.host,
            port: source.port,
            database: maintenanceDatabase,
            user: source.user,
            password: source.password,
            sslMode: source.sslMode
          }
        })
      : source.withDatabase(maintenanceDatabase);
  const resolved = {
    source,
    operator: operator.withDatabase(maintenanceDatabase),
    maintenanceDatabase
  };
  assertSingleLocalRecoveryEndpoint(resolved.source, resolved.operator);
  return resolved;
}

export function createPostgresRecoveryOperations(connections, ClientConstructor = Client) {
  const open = async (descriptor, database = descriptor.database) => {
    const client = new ClientConstructor(descriptor.nodeConfig(database));
    await client.connect();
    return client;
  };

  return {
    source: connections.source,
    operator: connections.operator,
    maintenanceDatabase: connections.maintenanceDatabase,

    async withExportedSnapshot(operation) {
      const client = await open(connections.source);
      let transactionOpen = false;
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        transactionOpen = true;
        const snapshotResult = await client.query("SELECT pg_export_snapshot() AS snapshot");
        const snapshot = snapshotResult.rows[0]?.snapshot;
        if (typeof snapshot !== "string" || !/^[0-9A-Fa-f:-]{3,160}$/.test(snapshot)) {
          throw new Error("PostgreSQL returned an invalid exported snapshot identifier");
        }
        const inventory = await collectPostgresInventory(client);
        const result = await operation({ snapshot, inventory });
        await client.query("COMMIT");
        transactionOpen = false;
        return result;
      } catch (error) {
        if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        await client.end().catch(() => undefined);
      }
    },

    async databaseExists(database) {
      const client = await open(connections.operator, connections.maintenanceDatabase);
      try {
        const result = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
        return result.rowCount > 0;
      } finally {
        await client.end().catch(() => undefined);
      }
    },

    async createDatabase(database, owner, marker) {
      const client = await open(connections.operator, connections.maintenanceDatabase);
      let created = false;
      let createdDatabaseOid;
      try {
        await acquireRecoveryDatabaseLock(client, database);
        if (await readDatabaseIdentityFrom(client, database)) {
          throw new Error(`Replacement PostgreSQL database already exists: ${database}`);
        }
        await client.query(`CREATE DATABASE ${quoteIdentifier(database)} OWNER ${quoteIdentifier(owner)}`);
        created = true;
        const createdIdentity = await readDatabaseIdentityFrom(client, database);
        if (!createdIdentity) throw new Error(`New project recovery database ${database} could not be identified`);
        createdDatabaseOid = createdIdentity.databaseOid;
        await client.query(`COMMENT ON DATABASE ${quoteIdentifier(database)} IS ${quoteLiteral(marker)}`);
        const identity = await readDatabaseIdentityFrom(client, database);
        if (!identity || identity.marker !== marker || identity.databaseOid !== createdDatabaseOid) {
          throw new Error(`New project recovery database ${database} did not retain its ownership marker`);
        }
        return { databaseOid: identity.databaseOid };
      } catch (error) {
        if (!created) throw error;
        try {
          const identity = await readDatabaseIdentityFrom(client, database);
          if (!identity || identity.databaseOid !== createdDatabaseOid) {
            throw new Error(`Refusing cleanup of replaced PostgreSQL database ${database}`);
          }
          if (identity.marker !== marker) {
            throw new Error(`Refusing cleanup of PostgreSQL database ${database} after its recovery marker changed`);
          }
          await client.query(`DROP DATABASE ${quoteIdentifier(database)}`);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], `Could not initialize or remove newly created project recovery database ${database}`);
        }
        throw error;
      } finally {
        await client.end().catch(() => undefined);
      }
    },

    async readInventory(database) {
      const client = await open(connections.operator, database);
      try {
        return await collectPostgresInventory(client);
      } finally {
        await client.end().catch(() => undefined);
      }
    },

    async readVerifiedInventory(database, expectedMarker, expectedDatabaseOid) {
      const client = await open(connections.operator, database);
      let transactionOpen = false;
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        transactionOpen = true;
        const identity = await readDatabaseIdentityFrom(client, database);
        if (!identity || identity.marker !== expectedMarker || identity.databaseOid !== String(expectedDatabaseOid)) {
          throw new Error(`PostgreSQL database ${database} lost its project recovery ownership identity`);
        }
        const inventory = await collectPostgresInventory(client);
        await client.query("COMMIT");
        transactionOpen = false;
        return { identity, inventory };
      } catch (error) {
        if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        await client.end().catch(() => undefined);
      }
    },

    async readDatabaseIdentity(database) {
      const client = await open(connections.operator, connections.maintenanceDatabase);
      try {
        return await readDatabaseIdentityFrom(client, database);
      } finally {
        await client.end().catch(() => undefined);
      }
    },

    async dropDatabase(database, expectedMarker, expectedDatabaseOid) {
      const client = await open(connections.operator, connections.maintenanceDatabase);
      try {
        await acquireRecoveryDatabaseLock(client, database);
        const identity = await readDatabaseIdentityFrom(client, database);
        if (!identity) return false;
        if (identity.marker !== expectedMarker || identity.databaseOid !== String(expectedDatabaseOid)) {
          throw new Error(`Refusing to drop PostgreSQL database ${database}: project recovery ownership identity mismatch`);
        }
        await client.query(`DROP DATABASE ${quoteIdentifier(database)}`);
        return true;
      } finally {
        await client.end().catch(() => undefined);
      }
    }
  };
}

async function acquireRecoveryDatabaseLock(client, database) {
  await client.query("SELECT pg_advisory_lock(hashtext('saltanatbotv2-project-recovery'), hashtext($1))", [database]);
}

async function readDatabaseIdentityFrom(client, database) {
  const result = await client.query("SELECT oid::text AS database_oid, shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = $1", [database]);
  if (result.rowCount === 0) return undefined;
  const databaseOid = String(result.rows[0]?.database_oid ?? "");
  if (!/^\d+$/.test(databaseOid)) throw new Error(`PostgreSQL database ${database} returned an invalid OID`);
  return { databaseOid, marker: result.rows[0]?.marker ?? undefined };
}

async function collectPostgresInventory(client) {
  const identityResult = await client.query(`
    SELECT
      current_database() AS database,
      pg_get_userbyid(datdba) AS owner
    FROM pg_database
    WHERE datname = current_database()
  `);
  const migrationResult = await client.query("SELECT version, name, checksum FROM public.schema_migrations ORDER BY version ASC");
  const countResult = await client.query(`
    SELECT
      (SELECT count(*)::text FROM public.users) AS users,
      (SELECT count(*)::text FROM public.workspaces) AS workspaces,
      (SELECT count(*)::text FROM public.workspace_revisions) AS workspace_revisions,
      (SELECT count(*)::text FROM public.compute_jobs) AS compute_jobs,
      to_regclass('public.user_onboarding') IS NOT NULL AS has_user_onboarding,
      to_regclass('public.executor_commands') IS NOT NULL AS has_executor_commands
  `);
  const userResult = await client.query("SELECT id::text AS id FROM public.users ORDER BY id ASC");
  const identity = identityResult.rows[0];
  const counts = countResult.rows[0];
  if (!identity || !counts) throw new Error("PostgreSQL recovery inventory returned no rows");
  const migrations = migrationResult.rows.map((row, index) => {
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version !== index + 1) {
      throw new Error("PostgreSQL schema migration inventory is not contiguous");
    }
    const name = boundedText(row.name, "PostgreSQL migration name", 160);
    const checksum = boundedText(row.checksum, "PostgreSQL migration checksum", 64);
    if (!/^[0-9a-f]{64}$/.test(checksum)) throw new Error(`PostgreSQL migration ${version} has an invalid checksum`);
    return { version, name, checksum };
  });
  const schemaVersion = migrations.at(-1)?.version ?? 0;
  if (typeof counts.has_user_onboarding !== "boolean") {
    throw new Error("PostgreSQL onboarding table inventory returned an invalid presence flag");
  }
  const hasOnboardingTable = counts.has_user_onboarding;
  if (schemaVersion >= ONBOARDING_SCHEMA_VERSION !== hasOnboardingTable) {
    throw new Error(`PostgreSQL schema ${schemaVersion} and user_onboarding table presence are inconsistent`);
  }
  if (typeof counts.has_executor_commands !== "boolean") {
    throw new Error("PostgreSQL executor command table inventory returned an invalid presence flag");
  }
  const hasExecutorCommandsTable = counts.has_executor_commands;
  if (schemaVersion >= EXECUTOR_COMMANDS_SCHEMA_VERSION !== hasExecutorCommandsTable) {
    throw new Error(`PostgreSQL schema ${schemaVersion} and executor_commands table presence are inconsistent`);
  }
  let userOnboarding = 0;
  if (hasOnboardingTable) {
    const onboardingResult = await client.query("SELECT count(*)::text AS user_onboarding FROM public.user_onboarding");
    const onboardingCounts = onboardingResult.rows[0];
    if (!onboardingCounts) {
      throw new Error("PostgreSQL onboarding recovery inventory returned no rows");
    }
    userOnboarding = countValue(onboardingCounts.user_onboarding, "onboarding rows");
  }
  let executorCommands = 0;
  if (hasExecutorCommandsTable) {
    const executorResult = await client.query("SELECT count(*)::text AS executor_commands FROM public.executor_commands");
    const executorCounts = executorResult.rows[0];
    if (!executorCounts) {
      throw new Error("PostgreSQL executor command recovery inventory returned no rows");
    }
    executorCommands = countValue(executorCounts.executor_commands, "executor commands");
  }
  const userIds = userResult.rows.map((row) => boundedText(row.id, "PostgreSQL user ID", 255));
  if (userIds.length !== countValue(counts.users, "users")) {
    throw new Error("PostgreSQL user snapshot inventory count mismatch");
  }
  return {
    database: boundedText(identity.database, "PostgreSQL database name", 255),
    owner: boundedText(identity.owner, "PostgreSQL owner name", 255),
    migrations,
    counts: {
      users: countValue(counts.users, "users"),
      workspaces: countValue(counts.workspaces, "workspaces"),
      workspaceRevisions: countValue(counts.workspace_revisions, "workspace revisions"),
      computeJobs: countValue(counts.compute_jobs, "compute jobs"),
      userOnboarding,
      ...(hasExecutorCommandsTable ? { executorCommands } : {})
    },
    userIds
  };
}

function connectionFromEnvironment(env, options) {
  for (const name of options.urlNames ?? []) {
    const value = firstText(env[name]);
    if (value) return connectionFromUrl(value, env, name);
  }
  const prefix = options.prefix;
  const fallback = options.fallbacks;
  const host = requiredName(env[`${prefix}HOST`], fallback.host, `${prefix}HOST`);
  const port = requiredPort(env[`${prefix}PORT`], fallback.port, `${prefix}PORT`);
  const database = requiredName(env[`${prefix}DATABASE`], fallback.database, `${prefix}DATABASE`);
  const user = requiredName(env[`${prefix}USER`], fallback.user, `${prefix}USER`);
  const password = resolvePassword(env[`${prefix}PASSWORD`], env[`${prefix}PASSWORD_FILE`], fallback.password, `${prefix}PASSWORD_FILE`);
  const sslMode = validSslMode(env[`${prefix}SSLMODE`], fallback.sslMode ?? "disable", `${prefix}SSLMODE`);
  return descriptor({ host, port, database, user, password, sslMode }, env);
}

function connectionFromUrl(raw, env, label) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL`);
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username) {
    throw new Error(`${label} must include a PostgreSQL protocol, hostname and user`);
  }
  const database = decode(url.pathname.replace(/^\//, ""));
  if (!database) throw new Error(`${label} must include a database name`);
  return descriptor(
    {
      host: url.hostname,
      port: requiredPort(url.port, "5432", `${label} port`),
      database: requiredName(database, undefined, `${label} database`),
      user: requiredName(decode(url.username), undefined, `${label} user`),
      password: url.password ? decode(url.password) : undefined,
      sslMode: validSslMode(url.searchParams.get("sslmode") ?? undefined, "disable", `${label} sslmode`)
    },
    env
  );
}

function descriptor(values, baseEnv) {
  const result = {
    host: values.host,
    port: values.port,
    database: values.database,
    user: values.user,
    sslMode: values.sslMode,
    nodeConfig(database = values.database) {
      return {
        host: values.host,
        port: Number(values.port),
        database,
        user: values.user,
        ...(values.password === undefined ? {} : { password: values.password }),
        ...(nodeSsl(values.sslMode) === undefined ? {} : { ssl: nodeSsl(values.sslMode) }),
        connectionTimeoutMillis: 10_000,
        statement_timeout: 300_000,
        query_timeout: 310_000,
        application_name: "saltanatbotv2-project-recovery"
      };
    },
    toolEnvironment(database = values.database) {
      return cleanEnvironment({
        ...allowedUtilityEnvironment(baseEnv),
        PGHOST: values.host,
        PGPORT: values.port,
        PGDATABASE: database,
        PGUSER: values.user,
        PGPASSWORD: values.password,
        PGSSLMODE: values.sslMode,
        PGCONNECT_TIMEOUT: "10",
        PGAPPNAME: "saltanatbotv2-project-recovery"
      });
    },
    withDatabase(database) {
      return descriptor({ ...values, database }, baseEnv);
    }
  };
  Object.defineProperty(result, "password", {
    value: values.password,
    enumerable: false,
    writable: false,
    configurable: false
  });
  return Object.freeze(result);
}

function resolvePassword(configured, file, fallback, label) {
  if (configured !== undefined && firstText(file)) throw new Error(`Set only one of ${label.replace("_FILE", "")} or ${label}`);
  if (configured !== undefined) return boundedPassword(configured, label.replace("_FILE", ""));
  if (!firstText(file)) return fallback;
  const filePath = String(file);
  if (!path.isAbsolute(filePath)) throw new Error(`${label} must be an absolute path`);
  const parentPath = path.dirname(filePath);
  const parentSnapshots = snapshotDirectoryComponents(parentPath, label);
  const entry = lstatSync(filePath);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (entry.nlink !== 1) throw new Error(`${label} must have exactly one hard link`);
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && entry.uid !== currentUid) throw new Error(`${label} must be owned by the recovery operator`);
  if (![0o400, 0o600].includes(entry.mode & 0o777)) throw new Error(`${label} permissions must be 0400 or 0600`);
  let descriptor;
  let parentDescriptor;
  let material;
  try {
    parentDescriptor = openSync(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0));
    const openedParent = fstatSync(parentDescriptor);
    const expectedParent = parentSnapshots.at(-1);
    if (!expectedParent || !openedParent.isDirectory() || !sameFilesystemIdentity(openedParent, expectedParent.entry)) {
      throw new Error(`${label} parent changed while it was opened`);
    }
    descriptor = openSync(`/proc/self/fd/${parentDescriptor}/${path.basename(filePath)}`, constants.O_RDONLY | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0));
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || !sameFilesystemIdentity(before, entry)) {
      throw new Error(`${label} changed while it was opened`);
    }
    if (before.size > MAX_PASSWORD_BYTES) throw new Error(`${label} is too large`);
    material = Buffer.alloc(Number(before.size) + 1);
    const bytesRead = readSync(descriptor, material, 0, material.length, 0);
    if (bytesRead !== before.size) throw new Error(`${label} changed while it was read`);
    const password = material
      .subarray(0, bytesRead)
      .toString("utf8")
      .replace(/\r?\n$/, "");
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(filePath);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.nlink !== 1 ||
      after.nlink !== 1 ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      pathAfter.dev !== before.dev ||
      pathAfter.ino !== before.ino ||
      pathAfter.size !== before.size ||
      pathAfter.mtimeMs !== before.mtimeMs ||
      pathAfter.ctimeMs !== before.ctimeMs ||
      pathAfter.uid !== before.uid ||
      (pathAfter.mode & 0o777) !== (before.mode & 0o777)
    ) {
      throw new Error(`${label} changed while it was read`);
    }
    assertDirectoryComponentsUnchanged(parentSnapshots, label);
    return boundedPassword(password, label);
  } finally {
    material?.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
    if (parentDescriptor !== undefined) closeSync(parentDescriptor);
  }
}

function snapshotDirectoryComponents(directory, label) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const snapshots = [];
  const rootEntry = lstatSync(current);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error(`${label} path root must be a real directory`);
  }
  snapshots.push({ path: current, entry: rootEntry });
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const entry = lstatSync(current);
    if (entry.isSymbolicLink()) {
      throw new Error(`${label} path must not contain symbolic-link components`);
    }
    if (!entry.isDirectory()) {
      throw new Error(`${label} path contains a non-directory component`);
    }
    snapshots.push({ path: current, entry });
  }
  return snapshots;
}

function assertDirectoryComponentsUnchanged(snapshots, label) {
  for (const snapshot of snapshots) {
    const current = lstatSync(snapshot.path);
    if (current.isSymbolicLink() || !current.isDirectory() || !sameFilesystemIdentity(current, snapshot.entry)) {
      throw new Error(`${label} directory components changed while it was read`);
    }
  }
}

function sameFilesystemIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode;
}

function boundedPassword(value, label) {
  if (Buffer.byteLength(value, "utf8") > MAX_PASSWORD_BYTES || value.includes("\0") || value.length === 0) {
    throw new Error(`${label} is empty or invalid`);
  }
  return value;
}

function databaseNameFromUrl(raw) {
  try {
    return decode(new URL(raw).pathname.replace(/^\//, "")) || DEFAULT_MAINTENANCE_DATABASE;
  } catch {
    return DEFAULT_MAINTENANCE_DATABASE;
  }
}

function requiredName(value, fallback, label) {
  const normalized = firstText(value) ?? fallback;
  if (!normalized || normalized.length > 255 || /[\0\r\n]/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function requiredPort(value, fallback, label) {
  const normalized = firstText(value) ?? fallback;
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be an integer`);
  const number = Number(normalized);
  if (!Number.isSafeInteger(number) || number < 1 || number > 65_535) throw new Error(`${label} must be between 1 and 65535`);
  return String(number);
}

function validSslMode(value, fallback, label) {
  const mode = requiredName(value, fallback, label);
  if (mode !== "disable") {
    throw new Error(`${label} must be disable for the reviewed loopback-only recovery boundary`);
  }
  return mode;
}

function assertSingleLocalRecoveryEndpoint(source, operator) {
  const loopbackHosts = new Set(["127.0.0.1", "::1"]);
  if (!loopbackHosts.has(source.host) || !loopbackHosts.has(operator.host) || source.host !== operator.host || source.port !== operator.port || source.sslMode !== "disable" || operator.sslMode !== "disable") {
    throw new Error("Project recovery source and operator must use one exact numeric loopback endpoint with sslmode=disable");
  }
}

function boundedText(value, label, maximum) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function countValue(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`PostgreSQL ${label} count is invalid`);
  return parsed;
}

function nodeSsl(mode) {
  if (mode === "disable") return false;
  if (mode === "require" || mode === "verify-ca" || mode === "verify-full") {
    return { rejectUnauthorized: mode !== "require" };
  }
  return undefined;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function cleanEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env)
      .filter((entry) => entry[1] !== undefined)
      .map(([key, value]) => [key, String(value)])
  );
}

function allowedUtilityEnvironment(env) {
  const allowed = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE", "LD_LIBRARY_PATH", "SSL_CERT_FILE", "SSL_CERT_DIR", "SYSTEMROOT", "WINDIR", "PATHEXT", "COMSPEC"];
  return Object.fromEntries(allowed.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])));
}

function firstText(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
