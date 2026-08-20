import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './SessionItem.tsx'), 'utf8');
const sidebar = fs.readFileSync(path.resolve(import.meta.dirname, '../../features/navigation-sidebar/sessions/SidebarSessionsToolbar.tsx'), 'utf8');

describe('external deployment Session presentation', () => {
  it('marks deployment Session rows with an ext badge', () => {
    expect(source).toContain(`kind === "deployment"`);
    expect(source).toContain('(ext)');
  });

  it('offers a dedicated external deployment filter', () => {
    expect(sidebar).toContain(`setKindFilter("external")`);
    expect(sidebar).toContain('t("externalDeploymentsWithExtension")');
    expect(sidebar).toContain(`sessionKindFilter === "external"`);
  });
});
