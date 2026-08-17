import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = fs.readFileSync(path.resolve(import.meta.dirname, '../../scripts/fleet/ensure-runtime-box-image.sh'), 'utf8');

describe('fleet Runtime Box image ensure contract', () => {
  it('normalizes missing sha256 image-id env refs to stable local tags before build', () => {
    expect(script).toContain('normalize_missing_image_id_ref()');
    expect(script).toContain('$key references missing image id $current; switching to stable local tag $fallback');
    expect(script).toContain('set_env_value "$key" "$fallback"');
    expect(script).toContain('IMAGE="$(normalize_missing_image_id_ref RUNTIME_BOX_IMAGE "$IMAGE" "$DEFAULT_IMAGE")"');
    expect(script).toContain('OPERATOR_IMAGE="$(normalize_missing_image_id_ref RUNTIME_BOX_OPERATOR_IMAGE "$OPERATOR_IMAGE" "$DEFAULT_OPERATOR_IMAGE")"');
  });
});
