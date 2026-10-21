import { describe, expect, it, vi } from 'vitest';
import argon2 from 'argon2';
import bcrypt from 'bcryptjs';
import { encryptPassword, hashPassword, PASSWORD_HASH_OPTIONS, verifyStoredPassword } from './auth.js';

describe('password read compatibility phase 1', () => {
  it('creates bounded Argon2id writes and verifies them', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(PASSWORD_HASH_OPTIONS).toMatchObject({ type: argon2.argon2id, memoryCost: 19 * 1024, timeCost: 2, parallelism: 1 });
    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(verifyStoredPassword('correct horse battery staple', hash)).resolves.toBe(true);
    await expect(verifyStoredPassword('wrong password', hash)).resolves.toBe(false);
  });

  it('bounds concurrent native hash operations to two', async () => {
    const original = argon2.hash;
    let running = 0, peak = 0;
    const spy = vi.spyOn(argon2, 'hash').mockImplementation(async (...args: Parameters<typeof argon2.hash>) => {
      running++; peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 4));
      running--;
      return original(...args);
    });
    try {
      const hashes = await Promise.all(Array.from({ length: 6 }, (_, i) => hashPassword(`fixture-${i}`)));
      expect(peak).toBeLessThanOrEqual(2);
      expect(new Set(hashes).size).toBe(6);
    } finally { spy.mockRestore(); }
  });

  it('keeps AES and bcrypt verification compatible', async () => {
    const password = 'legacy-password';
    await expect(verifyStoredPassword(password, encryptPassword(password))).resolves.toBe(true);
    await expect(verifyStoredPassword(password, bcrypt.hashSync(password, 4))).resolves.toBe(true);
  });

  it('treats malformed Argon2id values as invalid credentials', async () => {
    await expect(verifyStoredPassword('password', '$argon2id$malformed')).resolves.toBe(false);
  });
});


it('uses asynchronous bcrypt verification and preserves rejection of wrong passwords', async () => {
  const hash = bcrypt.hashSync('synthetic-password', 4);
  const sync = vi.spyOn(bcrypt, 'compareSync');
  const asyncCompare = vi.spyOn(bcrypt, 'compare');
  try {
    await expect(verifyStoredPassword('synthetic-password', hash)).resolves.toBe(true);
    await expect(verifyStoredPassword('wrong-password', hash)).resolves.toBe(false);
    expect(asyncCompare).toHaveBeenCalledTimes(2);
    expect(sync).not.toHaveBeenCalled();
  } finally { sync.mockRestore(); asyncCompare.mockRestore(); }
});
