import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const manager = fs.readFileSync(path.resolve(import.meta.dirname, 'room-manager.ts'), 'utf8');
const api = fs.readFileSync(path.resolve(import.meta.dirname, '../../routes/api.ts'), 'utf8');
const migration = fs.readFileSync(path.resolve(import.meta.dirname, '../../db/migrations/125_channel_membership_provenance.sql'), 'utf8');

describe('channel membership provenance and immutable history', () => {
  it('keeps channel listing read-only', () => {
    const listRooms = manager.slice(manager.indexOf('export async function listRooms'), manager.indexOf('export async function updateRoom'));
    expect(listRooms).not.toContain('INSERT INTO room_members');
    expect(listRooms).toContain('Listing is read-only');
  });

  it('stores current provenance and append-only event history', () => {
    expect(migration).toContain('membership_source');
    expect(migration).toContain('room_membership_events');
    expect(migration).toContain("'legacy_unknown'");
    expect(migration).toContain("'legacy_backfilled'");
  });

  it('records joins, rejoins, removals, self-leaves, and role changes', () => {
    expect(manager).toContain("hadHistory.rowCount ? 'rejoined' : 'joined'");
    expect(manager).toContain("audit.selfLeave ? 'left' : 'removed'");
    expect(manager).toContain("'role_changed'");
  });

  it('preserves provenance for archive while retiring manual membership mutation routes', () => {
    expect(api).not.toContain("router.post('/rooms/:id/members'");
    expect(api).not.toContain("router.delete('/rooms/:id/members/:userId'");
    expect(api).toContain("router.get('/rooms/:id/membership-events'");
    expect(api).toContain("router.get('/rooms/:id/archive'");
  });
});
