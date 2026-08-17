import { describe, expect, it } from 'vitest';
import { shouldDeferMigrationForVm } from './pg.js';

describe('managed Turn Rewind migration deferral', () => {
  it('allows checkpoint and all message-seq migration stages on self-hosted VMs by default', () => {
    const env = { TOWER_ROLE: 'managed' } as NodeJS.ProcessEnv;
    expect(shouldDeferMigrationForVm('158_turn_file_checkpoints.sql', env)).toBe(false);
    expect(shouldDeferMigrationForVm('159_messages_message_seq.sql', env)).toBe(false);
    expect(shouldDeferMigrationForVm('159_messages_message_seq_2_backfill.sql', env)).toBe(false);
    expect(shouldDeferMigrationForVm('159_messages_message_seq_3_notnull.sql', env)).toBe(false);
    expect(shouldDeferMigrationForVm('159_messages_message_seq_4_index.sql', env)).toBe(false);
  });

  it('keeps an explicit managed rollback hatch and never defers full or standalone VMs', () => {
    expect(shouldDeferMigrationForVm('159_messages_message_seq_2_backfill.sql', { TOWER_ROLE: 'managed', TOWER_TURN_REWIND_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldDeferMigrationForVm('159_messages_message_seq_2_backfill.sql', { TOWER_ROLE: 'managed', TOWER_TURN_REWIND_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldDeferMigrationForVm('159_messages_message_seq_2_backfill.sql', { TOWER_ROLE: 'full', TOWER_TURN_REWIND_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldDeferMigrationForVm('159_messages_message_seq_2_backfill.sql', { TOWER_ROLE: 'standalone', TOWER_TURN_REWIND_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldDeferMigrationForVm('160_unrelated.sql', { TOWER_ROLE: 'managed', TOWER_TURN_REWIND_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(false);
  });
});
