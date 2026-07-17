import type { PoolClient } from "pg";
import type { ExecutorCommandPruneResult } from "./executorCommandTypes.js";
import type { ValidatedExecutorCommandOptions } from "./executorCommandValidation.js";

export async function pruneExecutorCommandsForOwner(
  client: PoolClient,
  ownerUserId: string,
  options: ValidatedExecutorCommandOptions
): Promise<ExecutorCommandPruneResult> {
  const deletedByAge = await client.query(
    `WITH victims AS MATERIALIZED (
       SELECT id
       FROM executor_commands
       WHERE owner_user_id = $1
         AND status IN ('applied', 'rejected')
         AND terminal_at < clock_timestamp()
           - ($2::bigint * interval '1 millisecond')
       ORDER BY terminal_at ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $3
     )
     DELETE FROM executor_commands command
     USING victims
     WHERE command.id = victims.id`,
    [ownerUserId, options.terminalRetentionMs, options.pruneBatchSize]
  );
  const deletedByCount = await client.query(
    `WITH ranked AS MATERIALIZED (
       SELECT id, row_number() OVER (
         ORDER BY terminal_at DESC, id DESC
       ) AS retained_position
       FROM executor_commands
       WHERE owner_user_id = $1
         AND status IN ('applied', 'rejected')
     ), victims AS MATERIALIZED (
       SELECT command.id
       FROM executor_commands command
       INNER JOIN ranked ON ranked.id = command.id
       WHERE ranked.retained_position > $2
       ORDER BY command.terminal_at ASC, command.id ASC
       FOR UPDATE OF command SKIP LOCKED
       LIMIT $3
     )
     DELETE FROM executor_commands command
     USING victims
     WHERE command.id = victims.id`,
    [ownerUserId, options.maxTerminalPerOwner, options.pruneBatchSize]
  );
  return {
    deletedByAge: deletedByAge.rowCount ?? 0,
    deletedByCount: deletedByCount.rowCount ?? 0
  };
}
