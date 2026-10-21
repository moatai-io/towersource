import {it,expect} from 'vitest';import fs from 'node:fs';
it('initial interview cannot reference an uncommitted assistant in generic durable completion',()=>{const s=fs.readFileSync(new URL('./pi-engine.ts',import.meta.url),'utf8');expect(s).toContain("opts.initialInterview ? artifact?.savedMessageId");expect(s).toContain("opts.initialInterview ? finalArtifact?.savedMessageId");});
