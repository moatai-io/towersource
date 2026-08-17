#!/usr/bin/env node
/**
 * Short-lived Tower build monitor.
 *
 * Checks the running Tower /api/health payload for a new gitSha. If the running
 * build changed since the last check, posts a concise feature/change summary to
 * the project's townhall channel and emits normal Tower notifications. If not,
 * it stays silent. When monitor.maxRuns is a positive number, disables its
 * automation after that many checks; otherwise it keeps running.
 */
import { Client } from 'pg';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const automationId = process.argv[2];
if (!automationId) {
  console.error('usage: tower-build-monitor.js <automation-id>');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing');
  process.exit(2);
}

const DEFAULT_HEALTH_URL = process.env.TOWER_BUILD_MONITOR_HEALTH_URL || 'http://127.0.0.1:32364/api/health';

function shortId() {
  return crypto.randomBytes(5).toString('base64url').slice(0, 8).toLowerCase();
}

function jsonbMerge(obj, patch) {
  return JSON.stringify({ ...(obj || {}), ...patch });
}

async function fetchHealth(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'tower-build-monitor/1.0' } });
  if (!res.ok) throw new Error(`health HTTP ${res.status}`);
  const data = await res.json();
  return {
    version: data.version || null,
    baseVersion: data.baseVersion || null,
    commitsSinceTag: data.commitsSinceTag ?? null,
    gitSha: data.gitSha || null,
    buildTime: data.buildTime || null,
    buildId: data.buildId || null,
    publicUrl: data.publicUrl || null,
  };
}

function gitLogSummary(oldSha, newSha) {
  if (!oldSha || !newSha || oldSha === newSha) return [];
  const range = `${oldSha}..${newSha}`;
  try {
    const out = execFileSync('git', ['log', '--no-merges', '--format=%s', range], {
      cwd: '/home/tower/tower',
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return [];
    return out.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 8);
  } catch {
    try {
      const out = execFileSync('git', ['log', '--no-merges', '--format=%s', '-n', '8', newSha], {
        cwd: '/home/tower/tower',
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out ? out.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 8) : [];
    } catch {
      return [];
    }
  }
}

async function ensureTownhall(client, projectId, ownerUserId) {
  const existing = await client.query(
    `SELECT * FROM chat_rooms
      WHERE project_id = $1
        AND lower(name) = 'townhall'
        AND (archived IS NULL OR archived = 0)
      ORDER BY created_at ASC
      LIMIT 1`,
    [projectId],
  );
  if (existing.rows[0]) return existing.rows[0];

  for (let i = 0; i < 5; i++) {
    try {
      const { rows } = await client.query(
        `INSERT INTO chat_rooms (short_code, name, description, room_type, kind, project_id, created_by)
         VALUES ($1, 'townhall', 'Project townhall — shared schedule reports, AI notices, and team-wide updates.', 'project', 'user', $2, $3)
         RETURNING *`,
        [shortId(), projectId, ownerUserId],
      );
      const room = rows[0];
      await client.query(
        `INSERT INTO room_members (room_id, user_id, role)
         VALUES ($1, $2, 'owner')
         ON CONFLICT DO NOTHING`,
        [room.id, ownerUserId],
      );
      await client.query(
        `INSERT INTO room_members (room_id, user_id, role)
         SELECT $1, user_id, CASE WHEN role IN ('owner', 'admin') THEN 'admin' ELSE 'member' END
           FROM project_members
          WHERE project_id = $2
         ON CONFLICT DO NOTHING`,
        [room.id, projectId],
      );
      return room;
    } catch (err) {
      if (err.code === '23505') continue;
      throw err;
    }
  }
  throw new Error(`failed to create townhall for project=${projectId}`);
}

async function insertRoomMessage(client, roomId, content, metadata) {
  for (let i = 0; i < 5; i++) {
    try {
      const { rows } = await client.query(
        `INSERT INTO room_messages (room_id, sender_id, msg_type, content, metadata, short_id)
         VALUES ($1, NULL, 'system', $2, $3::jsonb, $4)
         RETURNING id, room_id, content, metadata, created_at, short_id`,
        [roomId, content, JSON.stringify(metadata), shortId()],
      );
      return rows[0];
    } catch (err) {
      if (err.code === '23505') continue;
      throw err;
    }
  }
  throw new Error('failed to allocate message short_id');
}

async function notifyRoomMembers(client, room, message, title, body, metadata) {
  const members = await client.query(
    `SELECT DISTINCT user_id FROM room_members WHERE room_id = $1`,
    [room.id],
  );
  const actionUrl = `/r/${room.short_code || room.id}#m-${message.short_id}`;
  for (const row of members.rows) {
    const notificationId = crypto.randomUUID();
    await client.query(
      `INSERT INTO notifications
         (id, user_id, room_id, notif_type, title, body, metadata, priority, action_url, channels, delivered_channels)
       VALUES
         ($1, $2, $3, 'proactive.message', $4, $5, $6::jsonb, 'normal', $7, '["in_app","toast"]'::jsonb, '{}'::jsonb)`,
      [notificationId, row.user_id, room.id, title, body, JSON.stringify({ ...metadata, roomMessageId: message.id, roomMessageShortId: message.short_id }), actionUrl],
    );
    const payload = JSON.stringify({
      origin: `tower-build-monitor-${process.pid}`,
      scope: 'user',
      userId: row.user_id,
      data: {
        type: 'notification',
        notification: {
          id: notificationId,
          userId: row.user_id,
          roomId: room.id,
          type: 'proactive.message',
          title,
          body,
          metadata: { ...metadata, roomMessageId: message.id, roomMessageShortId: message.short_id },
          priority: 'normal',
          actionUrl,
          channels: ['in_app', 'toast'],
          deliveredChannels: {},
          read: false,
          createdAt: new Date().toISOString(),
        },
      },
    });
    await client.query('SELECT pg_notify($1, $2)', ['tower_ws_events', payload]);
  }
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT * FROM automations WHERE id = $1 FOR UPDATE`,
      [automationId],
    );
    if (!rows[0]) throw new Error(`automation not found: ${automationId}`);
    const automation = rows[0];
    const def = automation.definition_json || {};
    const monitor = def.monitor || {};
    const maxRunsRaw = Number(monitor.maxRuns);
    const maxRuns = Number.isFinite(maxRunsRaw) && maxRunsRaw > 0 ? maxRunsRaw : null;
    const runNumber = Number(automation.run_count || 0) + 1;
    const runLabel = maxRuns ? `${runNumber}/${maxRuns}` : `${runNumber}`;
    const healthUrl = String(monitor.healthUrl || DEFAULT_HEALTH_URL);

    if (!automation.project_id) throw new Error('build monitor requires project_id');

    const health = await fetchHealth(healthUrl);
    const oldSha = monitor.lastSeenGitSha || null;
    const oldVersion = monitor.lastSeenVersion || null;
    const changed = !!oldSha && !!health.gitSha && oldSha !== health.gitSha;

    const room = await ensureTownhall(client, automation.project_id, automation.user_id);
    await client.query(
      `UPDATE automations
          SET target_id = $1, room_id = $1, updated_at = NOW()
        WHERE id = $2`,
      [room.id, automationId],
    );

    if (changed) {
      const commits = gitLogSummary(oldSha, health.gitSha);
      const commitLines = commits.length > 0
        ? commits.map((s) => `- ${s}`).join('\n')
        : '- 커밋 목록을 자동으로 읽지 못했지만, 실행 중인 빌드 SHA가 바뀌었습니다.';
      const content = [
        '새 Tower 빌드가 올라온 것 같아요.',
        '',
        `- 이전: ${oldVersion || 'unknown'} / ${oldSha}`,
        `- 현재: ${health.version || 'unknown'} / ${health.gitSha}`,
        `- 체크: ${runLabel}`,
        '',
        '주요 변경 후보:',
        commitLines,
      ].join('\n');
      const metadata = {
        persona: 'tower',
        severity: 'L2',
        towerNoti: {
          sourceType: 'automation',
          sourceId: automationId,
          sourceName: automation.name,
          reportPolicy: 'on_change',
          runNumber,
          maxRuns,
        },
        buildMonitor: { previous: { version: oldVersion, gitSha: oldSha }, current: health, commits },
        source: { kind: 'automation', id: automationId },
        channelName: 'townhall',
      };
      const message = await insertRoomMessage(client, room.id, content, metadata);
      await notifyRoomMembers(
        client,
        room,
        message,
        '새 Tower 빌드가 감지됐어요',
        `${oldSha} → ${health.gitSha} 변경을 감지했습니다.`,
        metadata,
      );
      const roomPayload = JSON.stringify({
        origin: `tower-build-monitor-${process.pid}`,
        scope: 'room',
        roomId: room.id,
        data: {
          type: 'room_message',
          roomId: room.id,
          message: {
            id: message.id,
            shortId: message.short_id,
            roomId: room.id,
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
    }

    const nextDef = jsonbMerge(def, {
      monitor: {
        ...monitor,
        healthUrl,
        maxRuns,
        lastSeenVersion: health.version,
        lastSeenGitSha: health.gitSha,
        lastSeenBuildId: health.buildId,
        lastSeenBuildTime: health.buildTime,
        lastCheckedAt: new Date().toISOString(),
      },
    });
    const disableClause = maxRuns && runNumber >= maxRuns ? ', enabled = false, next_run_at = NULL' : '';
    await client.query(
      `UPDATE automations
          SET definition_json = $1::jsonb, updated_at = NOW()${disableClause}
        WHERE id = $2`,
      [nextDef, automationId],
    );

    await client.query('COMMIT');
    console.log(changed
      ? `build changed ${oldSha} -> ${health.gitSha} (${runLabel})`
      : `no build change (${runLabel}) current=${health.gitSha || 'unknown'}`);
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
