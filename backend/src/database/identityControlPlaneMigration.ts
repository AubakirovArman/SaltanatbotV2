export const IDENTITY_CONTROL_PLANE_MIGRATION_SQL = `
      ALTER TABLE auth_sessions
        ADD COLUMN public_id UUID;

      UPDATE auth_sessions
        SET public_id = (
          substr(md5('saltanatbotv2-auth-session-public-id:v1:' || id_hash), 1, 8) || '-' ||
          substr(md5('saltanatbotv2-auth-session-public-id:v1:' || id_hash), 9, 4) || '-' ||
          substr(md5('saltanatbotv2-auth-session-public-id:v1:' || id_hash), 13, 4) || '-' ||
          substr(md5('saltanatbotv2-auth-session-public-id:v1:' || id_hash), 17, 4) || '-' ||
          substr(md5('saltanatbotv2-auth-session-public-id:v1:' || id_hash), 21, 12)
        )::uuid
        WHERE public_id IS NULL;

      ALTER TABLE auth_sessions
        ALTER COLUMN public_id SET NOT NULL,
        ADD CONSTRAINT auth_sessions_public_id_unique UNIQUE (public_id);

      CREATE INDEX users_created_at_id_index
        ON users (created_at DESC, id DESC);
      CREATE INDEX users_status_created_at_id_index
        ON users (status, created_at DESC, id DESC);
      CREATE INDEX auth_sessions_user_created_public_index
        ON auth_sessions (user_id, created_at DESC, public_id DESC);
      CREATE INDEX audit_events_occurred_at_id_index
        ON audit_events (occurred_at DESC, id DESC);
      CREATE INDEX audit_events_event_occurred_id_index
        ON audit_events (event_type, occurred_at DESC, id DESC);
      CREATE INDEX audit_events_subject_occurred_id_index
        ON audit_events (subject_user_id, occurred_at DESC, id DESC)
        WHERE subject_user_id IS NOT NULL;

      UPDATE auth_sessions AS session
        SET revoked_at = COALESCE(session.revoked_at, clock_timestamp()),
            revoke_reason = COALESCE(
              session.revoke_reason,
              'pre_https_live_role_downgrade'
            )
        FROM users AS affected_user
        WHERE affected_user.id = session.user_id
          AND affected_user.app_role <> 'admin'
          AND affected_user.trading_role = 'live-trade'
          AND session.revoked_at IS NULL;

      DELETE FROM auth_ws_tickets AS ticket
        USING users AS affected_user
        WHERE affected_user.id = ticket.user_id
          AND affected_user.app_role <> 'admin'
          AND affected_user.trading_role = 'live-trade';

      INSERT INTO audit_events (
        event_type,
        subject_user_id,
        request_id,
        metadata,
        occurred_at
      )
      SELECT
        'user.permissions_migrated',
        affected_user.id,
        'migration:v9',
        jsonb_build_object(
          'reason', 'pre_https_live_role_downgrade',
          'before', jsonb_build_object(
            'status', affected_user.status,
            'appRole', affected_user.app_role,
            'tradingRole', affected_user.trading_role,
            'authorizationRevision', affected_user.authorization_revision
          ),
          'after', jsonb_build_object(
            'status', affected_user.status,
            'appRole', affected_user.app_role,
            'tradingRole', 'paper-trade',
            'authorizationRevision', affected_user.authorization_revision + 1
          )
        ),
        clock_timestamp()
      FROM users AS affected_user
      WHERE affected_user.app_role <> 'admin'
        AND affected_user.trading_role = 'live-trade';

      UPDATE users
        SET trading_role = 'paper-trade',
            authorization_revision = authorization_revision + 1,
            updated_at = clock_timestamp()
        WHERE app_role <> 'admin'
          AND trading_role = 'live-trade';

      ALTER TABLE users
        ADD CONSTRAINT users_non_admin_live_trading_forbidden
        CHECK (app_role = 'admin' OR trading_role <> 'live-trade');
    `;
