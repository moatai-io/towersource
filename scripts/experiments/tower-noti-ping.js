#!/usr/bin/env node
/**
 * Tower Noti channel-first smoke experiment.
 *
 * Posts a natural-language ping to the user's private Personal AI channel every
 * scheduled run, then disables its automation after 10 visible pings. No secrets
 * are printed.
 */
import { Client } from 'pg';
import crypto from 'node:crypto';

const automationId = process.argv[2];
if (!automationId) {
  console.error('usage: tower-noti-ping.js <automation-id>');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing');
  process.exit(2);
}

const MAX_RUNS = 10;
const TARGET_USER_ID = 1;
const PERSONAL_AI_NAME = 'Personal AI';
const PERSONAL_AI_DESCRIPTION = 'Personal AI — private AI messages, schedule wake-ups, and Tower Noti signals for you.';

function shortId() {
  // 8 chars, URL-friendly enough for room/message short_id.
  return crypto.randomBytes(5).toString('base64url').slice(0, 8).toLowerCase();
}

async function ensurePersonalAiChannel(client) {
  const existing = await client.query(
    `SELECT * FROM chat_rooms
      WHERE kind = 'personal_ai'
        AND created_by = $1
        AND (archived IS NULL OR archived = 0)
      ORDER BY created_at ASC
      LIMIT 1`,
    [TARGET_USER_ID],
  );
  if (existing.rows[0]) return existing.rows[0];

  for (let i = 0; i < 5; i++) {
    try {
      const { rows } = await client.query(
        `INSERT INTO chat_rooms (short_code, name, description, room_type, kind, created_by)
         VALUES ($1, $2, $3, 'team', 'personal_ai', $4)
         RETURNING *`,
        [shortId(), PERSONAL_AI_NAME, PERSONAL_AI_DESCRIPTION, TARGET_USER_ID],
      );
      const room = rows[0];
      await client.query(
        `INSERT INTO room_members (room_id, user_id, role)
         VALUES ($1, $2, 'owner')
         ON CONFLICT DO NOTHING`,
        [room.id, TARGET_USER_ID],
      );
      return room;
    } catch (err) {
      if (err.code === '23505') continue;
      throw err;
    }
  }
  throw new Error('failed to create Personal AI channel');
}

async function insertRoomMessage(client, roomId, content, metadata) {
  for (let i = 0; i < 5; i++) {
    const sid = shortId();
    try {
      const { rows } = await client.query(
        `INSERT INTO room_messages (room_id, sender_id, msg_type, content, metadata, short_id)
         VALUES ($1, NULL, 'system', $2, $3::jsonb, $4)
         RETURNING id, room_id, content, metadata, created_at, short_id`,
        [roomId, content, JSON.stringify(metadata), sid],
      );
      return rows[0];
    } catch (err) {
      if (err.code === '23505') continue;
      throw err;
    }
  }
  throw new Error('failed to allocate room message short_id');
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');

    const personalRoom = await ensurePersonalAiChannel(client);
    const roomId = personalRoom.id;
    const roomShortCode = personalRoom.short_code || personalRoom.id;

    const { rows } = await client.query(
      `SELECT id, name, run_count, enabled
         FROM automations
        WHERE id = $1
        FOR UPDATE`,
      [automationId],
    );
    if (rows.length === 0) throw new Error(`automation not found: ${automationId}`);
    const automation = rows[0];

    await client.query(
      `UPDATE automations
          SET target_id = $1, room_id = $1, updated_at = NOW()
        WHERE id = $2`,
      [roomId, automationId],
    );

    // Count actual successful channel pings, not automation.run_count. The
    // scheduler increments run_count even for failed shell starts; this smoke
    // should stop after 10 visible Personal AI messages.
    const countResult = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM room_messages
        WHERE room_id = $1
          AND deleted_at IS NULL
          AND metadata->'towerNoti'->>'sourceId' = $2`,
      [roomId, automationId],
    );
    const postedCount = Number(countResult.rows[0]?.count || 0);
    const nextRunNumber = postedCount + 1;

    if (!automation.enabled || postedCount >= MAX_RUNS) {
      await client.query(
        `UPDATE automations
            SET enabled = false, next_run_at = NULL, updated_at = NOW()
          WHERE id = $1`,
        [automationId],
      );
      await client.query('COMMIT');
      console.log(`Tower Noti smoke already complete: ${postedCount}/${MAX_RUNS}`);
      return;
    }

    const content = [
      `영록님, 방금 제가 테스트한 것이 있어요!`,
      `여기는 개인용 ${PERSONAL_AI_NAME} 채널이고, 이번이 ${nextRunNumber}/${MAX_RUNS}번째 Tower Noti 호출입니다.`,
      `공용 general이 아니라 이렇게 개인 채널에서 제가 먼저 말을 걸어야 훨씬 자연스럽겠어요.`,
      `Personal AI 채널로 바로 들어가기: https://tower.tower.example.com/r/${roomShortCode}`,
      nextRunNumber === MAX_RUNS
        ? `이 메시지가 마지막 테스트 호출이에요. 이제 이 자동화는 스스로 꺼집니다.`
        : `3분 뒤에 한 번 더 말을 걸어볼게요.`,
    ].join('\n');

    const metadata = {
      persona: 'tower',
      severity: 'L2',
      towerNoti: {
        experiment: 'channel-first-proactive-signal',
        level: 'interesting',
        runNumber: nextRunNumber,
        maxRuns: MAX_RUNS,
        sourceType: 'automation',
        sourceId: automationId,
        sourceName: automation.name,
        channelKind: 'personal_ai',
      },
      source: { kind: 'automation', id: automationId },
      actionUrl: `/r/${roomShortCode}`,
      channelName: PERSONAL_AI_NAME,
    };

    const message = await insertRoomMessage(client, roomId, content, metadata);

    // Lightweight in-app/browser-noti path: create a normal notification that
    // links back to the channel message. User preferences still decide how it is surfaced.
    const notificationId = crypto.randomUUID();
    await client.query(
      `INSERT INTO notifications
         (id, user_id, room_id, notif_type, title, body, metadata, priority, action_url, channels, delivered_channels)
       VALUES
         ($1, $2, $3, 'proactive.message', $4, $5, $6::jsonb, 'normal', $7, '["in_app","toast"]'::jsonb, '{}'::jsonb)`,
      [
        notificationId,
        TARGET_USER_ID,
        roomId,
        '영록님, 방금 제가 테스트한 것이 있어요!',
        `Personal AI에서 Tower Noti ${nextRunNumber}/${MAX_RUNS}번째 호출이 왔습니다.`,
        JSON.stringify({ ...metadata, roomMessageId: message.id, roomMessageShortId: message.short_id }),
        `/r/${roomShortCode}#m-${message.short_id}`,
      ],
    );

    if (nextRunNumber >= MAX_RUNS) {
      await client.query(
        `UPDATE automations
            SET enabled = false, next_run_at = NULL, updated_at = NOW()
          WHERE id = $1`,
        [automationId],
      );
    }

    await client.query('COMMIT');

    // Wake connected backend instances to refresh channel and notification UIs.
    const roomPayload = JSON.stringify({
      origin: `tower-noti-smoke-${process.pid}`,
      scope: 'room',
      roomId,
      data: {
        type: 'room_message',
        roomId,
        message: {
          id: message.id,
          shortId: message.short_id,
          roomId,
          senderId: null,
          senderName: 'Tower',
          msgType: 'system',
          content: message.content,
          metadata,
          replyTo: null,
          createdAt: message.created_at instanceof Date ? message.created_at.toISOString() : String(message.created_at),
        },
      },
    });
    await client.query('SELECT pg_notify($1, $2)', ['tower_ws_events', roomPayload]);

    const notificationPayload = JSON.stringify({
      origin: `tower-noti-smoke-${process.pid}`,
      scope: 'user',
      userId: TARGET_USER_ID,
      data: {
        type: 'notification',
        notification: {
          id: notificationId,
          userId: TARGET_USER_ID,
          roomId,
          type: 'proactive.message',
          title: '영록님, 방금 제가 테스트한 것이 있어요!',
          body: `Personal AI에서 Tower Noti ${nextRunNumber}/${MAX_RUNS}번째 호출이 왔습니다.`,
          metadata: { ...metadata, roomMessageId: message.id, roomMessageShortId: message.short_id },
          priority: 'normal',
          actionUrl: `/r/${roomShortCode}#m-${message.short_id}`,
          channels: ['in_app', 'toast'],
          deliveredChannels: {},
          read: false,
          createdAt: new Date().toISOString(),
        },
      },
    });
    await client.query('SELECT pg_notify($1, $2)', ['tower_ws_events', notificationPayload]);

    console.log(`Tower Noti Personal AI ping posted (${nextRunNumber}/${MAX_RUNS}) room=${roomShortCode} message=${message.id}`);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
