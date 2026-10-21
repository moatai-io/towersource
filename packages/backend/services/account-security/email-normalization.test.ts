import { describe, expect, it } from 'vitest';
import { AccountEmailValidationError, maskAccountEmail, normalizeAccountEmail } from './email-normalization.js';

describe('account email normalization', () => {
  it('trims display form and lowercases the uniqueness key', () => {
    expect(normalizeAccountEmail(' User.Name+tag@Example.COM ')).toEqual({
      email: 'User.Name+tag@Example.COM',
      normalized: 'user.name+tag@example.com',
    });
  });

  it('does not apply provider-specific dot or plus normalization', () => {
    expect(normalizeAccountEmail('user.name+tag@gmail.com').normalized).toBe('user.name+tag@gmail.com');
  });

  it.each(['', 'not-an-email', 'a@', '@example.com', 'a b@example.com'])(
    'rejects invalid email %j',
    (value) => expect(() => normalizeAccountEmail(value)).toThrow(AccountEmailValidationError),
  );

  it('masks the local part without hiding the delivery domain', () => {
    expect(maskAccountEmail('woomin@example.com')).toBe('w*****@example.com');
  });
});
