/** Per-owner transactional event ordering for lossless forward cursors. */
export const ALERT_EVENT_SEQUENCE_MIGRATION_SQL = `
  CREATE TABLE alert_event_sequences (
    owner_user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_sequence BIGINT NOT NULL CHECK (last_sequence > 0)
  );

  ALTER TABLE alert_rule_events
    ADD COLUMN owner_sequence BIGINT NOT NULL;
  CREATE UNIQUE INDEX alert_rule_events_owner_sequence_unique
    ON alert_rule_events (owner_user_id, owner_sequence ASC);

  CREATE FUNCTION assign_alert_event_owner_sequence()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    EXECUTE format(
      'INSERT INTO %I.alert_event_sequences AS counter (owner_user_id, last_sequence)
       VALUES ($1, 1)
       ON CONFLICT (owner_user_id) DO UPDATE
         SET last_sequence = counter.last_sequence + 1
       RETURNING last_sequence',
      TG_TABLE_SCHEMA
    ) INTO NEW.owner_sequence USING NEW.owner_user_id;
    RETURN NEW;
  END;
  $$;

  CREATE TRIGGER alert_rule_events_assign_owner_sequence
    BEFORE INSERT ON alert_rule_events
    FOR EACH ROW
    EXECUTE FUNCTION assign_alert_event_owner_sequence();
`;
