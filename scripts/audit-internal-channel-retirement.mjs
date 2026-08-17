#!/usr/bin/env node
/**
 * Read-only inventory for retiring Tower's internal chat_rooms channels.
 *
 * This deliberately reads counts and timestamps only. It never selects message
 * content, webhook token hashes, file paths, or other payload-bearing columns.
 */

import pg from 'pg';

const { Client } = pg;

function parseArgs(argv) {
  const args = { json: false };
  for (const arg of argv) {
    if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/audit-internal-channel-retirement.mjs [--json]\n\nEnvironment:\n  DATABASE_URL  PostgreSQL connection string (required)\n\nThe audit is read-only and never reads room message content, file paths, or token hashes.`);
}

async function tableExists(client, tableName) {
  const result = await client.query('SELECT to_regclass($1) IS NOT NULL AS exists', [`public.${tableName}`]);
  return result.rows[0]?.exists === true;
}

async function one(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows[0] || {};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');

    const required = ['chat_rooms', 'room_messages', 'room_members', 'automations'];
    const optional = ['room_webhook_tokens', 'channel_shared_files', 'channel_agent_memberships', 'room_ai_context', 'sessions', 'tasks'];
    const existence = {};
    for (const name of [...required, ...optional]) existence[name] = await tableExists(client, name);
    const missingRequired = required.filter((name) => !existence[name]);
    if (missingRequired.length > 0) throw new Error(`Missing required tables: ${missingRequired.join(', ')}`);

    const rooms = await one(client, `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE archived IS NULL OR archived = 0)::int AS active,
        COUNT(*) FILTER (WHERE kind = 'tower_system' AND (archived IS NULL OR archived = 0))::int AS active_tower_system,
        COUNT(*) FILTER (WHERE kind = 'personal_ai' AND (archived IS NULL OR archived = 0))::int AS active_personal_ai,
        COUNT(*) FILTER (WHERE COALESCE(kind, 'user') NOT IN ('tower_system', 'personal_ai') AND (archived IS NULL OR archived = 0))::int AS active_user_channels,
        MAX(created_at) AS last_created_at
      FROM chat_rooms
    `);

    const messages = await one(client, `
      SELECT
        COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS total_active,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND sender_id IS NOT NULL)::int AS total_user_authored,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND sender_id IS NOT NULL AND created_at >= NOW() - INTERVAL '30 days')::int AS user_authored_30d,
        MAX(created_at) FILTER (WHERE deleted_at IS NULL AND sender_id IS NOT NULL) AS last_user_authored_at
      FROM room_messages
    `);

    const memberships = await one(client, 'SELECT COUNT(*)::int AS total FROM room_members');
    const automations = await one(client, `
      SELECT
        COUNT(*) FILTER (WHERE status <> 'archived' AND mode = 'channel')::int AS active_channel_mode,
        COUNT(*) FILTER (WHERE status <> 'archived' AND (room_id IS NOT NULL OR target_id IN (SELECT id FROM chat_rooms)))::int AS active_room_bound,
        MAX(created_at) FILTER (WHERE mode = 'channel') AS last_channel_mode_created_at
      FROM automations
    `);

    const countOptional = async (table, where = '') => existence[table]
      ? Number((await one(client, `SELECT COUNT(*)::int AS total FROM ${table} ${where}`)).total || 0)
      : null;

    const report = {
      generatedAt: new Date().toISOString(),
      scope: 'internal-chat-rooms-only',
      privacy: 'counts-and-timestamps-only',
      rooms,
      messages,
      memberships: Number(memberships.total || 0),
      dependencies: {
        activeWebhookTokens: await countOptional('room_webhook_tokens', 'WHERE revoked_at IS NULL'),
        activeSharedFiles: await countOptional('channel_shared_files', 'WHERE removed_at IS NULL'),
        activeAgentMemberships: await countOptional('channel_agent_memberships', 'WHERE revoked_at IS NULL'),
        roomAiContextRows: await countOptional('room_ai_context'),
        roomBoundSessions: existence.sessions ? Number((await one(client, 'SELECT COUNT(*)::int AS total FROM sessions WHERE room_id IS NOT NULL')).total || 0) : null,
        roomBoundTasks: existence.tasks ? Number((await one(client, 'SELECT COUNT(*)::int AS total FROM tasks WHERE room_id IS NOT NULL')).total || 0) : null,
      },
      automations,
      excluded: ['ai_service_channels', 'ai_service_conversations', 'notification records'],
    };

    await client.query('ROLLBACK');
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log('Tower internal channel retirement inventory');
      console.log(JSON.stringify(report, null, 2));
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`[channel-retirement-audit] ${error.message}`);
  process.exitCode = 1;
});
