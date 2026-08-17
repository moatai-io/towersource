import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const route = fs.readFileSync(path.resolve(import.meta.dirname, './approval-card-api.ts'), 'utf8');
const api = fs.readFileSync(path.resolve(import.meta.dirname, './api.ts'), 'utf8');

describe('Approval Card API visibility', () => {
  it('keeps the preserved router unmounted while the product surface is hidden', () => {
    expect(api).not.toContain("import approvalCardRouter from './approval-card-api.js'");
    expect(api).not.toContain("router.use('/approval-cards', approvalCardRouter)");
  });

  it('preserves list, create, detail, resolve, and resubmit implementation for a future bounded reintroduction', () => {
    expect(route).toContain("router.get('/',");
    expect(route).toContain("router.post('/',");
    expect(route).toContain("router.get('/:id',");
    expect(route).toContain("router.post('/:id/resolve',");
    expect(route).toContain("router.post('/:id/resubmit',");
  });
});
