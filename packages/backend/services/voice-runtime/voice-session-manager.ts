/**
 * Owns: In-memory lifecycle for short-lived voice connections linked to durable Tower Sessions.
 * Public API: VoiceSessionManager. See README.md.
 */

import crypto from 'node:crypto';
import type { VoiceRuntimeConfig, VoiceSessionDescriptor } from './types.js';

const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** Keeps ephemeral media state out of the durable Session/message model. */
export class VoiceSessionManager {
  private readonly sessions = new Map<string, VoiceSessionDescriptor>();

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  start(towerSessionId: string, userId: number, config?: Partial<VoiceRuntimeConfig>): VoiceSessionDescriptor {
    this.prune();
    const now = Date.now();
    const descriptor: VoiceSessionDescriptor = {
      id: crypto.randomUUID(),
      towerSessionId,
      userId,
      status: 'connecting',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      config: {
        sttProvider: 'clova',
        ttsProvider: config?.ttsProvider ?? 'typecast',
        language: 'ko-KR',
        maxSpokenSeconds: Math.min(30, Math.max(5, config?.maxSpokenSeconds ?? 30)),
      },
    };
    this.sessions.set(descriptor.id, descriptor);
    return descriptor;
  }

  get(id: string): VoiceSessionDescriptor | null {
    this.prune();
    return this.sessions.get(id) ?? null;
  }

  setStatus(id: string, status: VoiceSessionDescriptor['status']): VoiceSessionDescriptor | null {
    const current = this.get(id);
    if (!current) return null;
    const next = { ...current, status };
    this.sessions.set(id, next);
    return next;
  }

  stop(id: string, userId: number): boolean {
    const current = this.get(id);
    if (!current || current.userId !== userId) return false;
    this.sessions.delete(id);
    return true;
  }

  private prune(now = Date.now()): void {
    for (const [id, session] of this.sessions) {
      if (Date.parse(session.expiresAt) <= now) this.sessions.delete(id);
    }
  }
}
