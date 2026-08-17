import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../../scripts/fleet/promote-runtime-box-image'), 'utf8');

describe('Runtime Box immutable image promotion', () => {
  it('builds the operator image from the local base tag instead of a bare image id', () => {
    expect(source).toContain('--build-arg BASE_IMAGE="$base_tag"');
    expect(source).not.toContain('--build-arg BASE_IMAGE="$base_id"');
  });

  it('still records the immutable base image id in labels and the promotion ledger', () => {
    expect(source).toContain('--label "tower.runtime-box.base-image-id=$base_id"');
    expect(source).toContain("'baseImageId':base");
  });

  it('reuses a pinned upstream digest when both Runtime Box contexts are unchanged', () => {
    expect(source).toContain("a.get('baseContextSha256')==sys.argv[2]");
    expect(source).toContain("a.get('operatorContextSha256')==sys.argv[3]");
    expect(source).toContain("a.get('upstreamBaseDigest')");
    expect(source).toContain('if [[ ! "$upstream" =~ ^sha256:');
  });
});
