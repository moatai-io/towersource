import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const taskDir = import.meta.dirname;
const scheduler = fs.readFileSync(path.resolve(taskDir, 'unified-scheduler.ts'), 'utf8');
const runners = fs.readFileSync(path.resolve(taskDir, 'automation-runners.ts'), 'utf8');
const taskRunner = fs.readFileSync(path.resolve(taskDir, 'task-runner.ts'), 'utf8');
const automationControl = fs.readFileSync(path.resolve(taskDir, 'automation-control.ts'), 'utf8');
const proactive = fs.readFileSync(path.resolve(taskDir, '../ai/proactive-agent.ts'), 'utf8');
const notificationHub = fs.readFileSync(path.resolve(taskDir, '../notification-hub.ts'), 'utf8');
const notificationTypes = fs.readFileSync(path.resolve(taskDir, '../notifications/notification-types.ts'), 'utf8');
const wsHandler = fs.readFileSync(path.resolve(taskDir, '../../routes/ws-handler.ts'), 'utf8');

describe('internal channel reports migrate to Notification Hub', () => {
  it('keeps automation-owned spawn Tasks silent so only the Run owner reports completion', () => {
    const spawn = runners.slice(runners.indexOf("if (mode === 'spawn')"), runners.indexOf("if (mode === 'inject')"));
    expect(spawn).toMatch(/createTask\([\s\S]*?'silent'/);
    expect(spawn).toContain('getTask(task.id)');
    expect(taskRunner).toContain('if (!routeSeverity(severity).notifyInApp || !task.userId) return;');
    expect(scheduler).toContain('!executionResult?.replayedOccurrence');
    expect(scheduler).toContain('runId: terminalSession?.runId');
  });
  it('provides one shared Task/Automation terminal report helper', () => {
    expect(notificationHub).toContain('export async function notifyExecutionReport');
    expect(notificationHub).toContain("const type = `${input.kind}.${input.status}`");
    expect(notificationHub).toContain("priority: failed ? 'high' : 'normal'");
    expect(notificationHub).toContain('actionUrl: input.actionUrl ?? null');
  });

  it('keeps execution reports in Notification Center by default', () => {
    for (const type of ['task.completed', 'task.failed', 'automation.completed', 'automation.failed', 'proactive.message']) {
      const block = notificationTypes.slice(notificationTypes.indexOf(`eventType: '${type}'`));
      expect(block.slice(0, 320)).toContain('inApp: true');
    }
  });

  it('routes scheduled and manual Automation reports through Notification', () => {
    expect(scheduler).toContain('await notifyExecutionReport({');
    expect(scheduler).not.toContain('await postToTowerChannel(');
    expect(automationControl).toContain('await notifyExecutionReport({');
  });

  it('runs legacy channel mode as a Session without room writes', () => {
    expect(runners).toContain("legacyMode: 'channel'");
    expect(runners).toContain('suppressCompletionNotification: true');
    expect(runners).not.toContain('{ reportRoomId, automationId: automation.id }');
    expect(scheduler).toContain("legacyMode: schedule.mode === 'channel' ? 'channel' : undefined");
    expect(scheduler).not.toContain('channel mode requires target_id (room_id)');
  });

  it('routes Task reports once and removes the old WebSocket duplicate', () => {
    expect(taskRunner).toContain('notifyExecutionReport({');
    expect(taskRunner).not.toContain('sendRoomMsg(');
    expect(taskRunner).not.toContain('postToTowerChannel(');
    expect(wsHandler).toContain('task-runner owns the single terminal Notification');
    expect(wsHandler).not.toContain("payload.status === 'done' ? 'task_done' : 'task_failed'");
  });

  it('keeps standalone proactive notifications but lets Automation suppress duplicates', () => {
    expect(proactive).toContain('suppressCompletionNotification?: boolean');
    expect(proactive).toContain("options?.suppressCompletionNotification");
    expect(proactive).not.toContain('broadcastToRoom(options.reportRoomId');
  });
});
