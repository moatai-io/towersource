import{describe,expect,it}from'vitest';import{AGENT_CHARACTERS,agentCharacterListPresentation,characterFace,distributedKoreanCharacterId}from'./characters';
describe('agent character prototype catalog',()=>{it('keeps the reviewed seventy-three-character catalog',()=>{expect(AGENT_CHARACTERS).toHaveLength(73);expect(new Set(AGENT_CHARACTERS.map(x=>x.id)).size).toBe(73);expect(AGENT_CHARACTERS.filter(x=>x.group==='core')).toHaveLength(3);expect(AGENT_CHARACTERS.filter(x=>x.group==='korean')).toHaveLength(70)});it('keeps distinct labels for Korean characters',()=>{const korean=AGENT_CHARACTERS.filter(x=>x.group==='korean');expect(new Set(korean.map(x=>x.label)).size).toBe(70);expect(korean.every(x=>x.label.length>0)).toBe(true)});it('provides reviewed list crops and identity accents for every curated character',()=>{for(const character of AGENT_CHARACTERS){const presentation=agentCharacterListPresentation(character.id);expect(presentation.crop?.scale).toBeGreaterThan(1);expect(presentation.crop?.x).toBeGreaterThanOrEqual(0);expect(presentation.crop?.x).toBeLessThanOrEqual(100);expect(presentation.crop?.y).toBeGreaterThanOrEqual(0);expect(presentation.crop?.y).toBeLessThanOrEqual(100);expect(presentation.accent).toMatch(/^#[0-9a-f]{6}$/i)}});it('encodes character ids in the existing face field',()=>{expect(characterFace('character:korean-core-3')).toBe('korean-core-3');expect(characterFace('✨')).toBeNull()});it('distributes stable Korean characters across project ids',()=>{const ids=Array.from({length:40},(_,index)=>distributedKoreanCharacterId(`project-${index}`));expect(new Set(ids).size).toBeGreaterThanOrEqual(4);expect(ids.every(id=>id.startsWith('korean-diverse-'))).toBe(true);expect(distributedKoreanCharacterId('project-17')).toBe(distributedKoreanCharacterId('project-17'))})});

describe('refined catalog compatibility', () => {
  it('preserves all saved legacy character IDs', () => {
    const ids = AGENT_CHARACTERS.map(character => character.id);
    for (const id of ['core-talent', 'core-editor', 'core-engineer', ...Array.from({ length: 10 }, (_, i) => `korean-diverse-${i + 1}`)]) {
      expect(ids).toContain(id);
    }
  });
  it('keeps automatic fallback identities in the original pool', () => {
    const pool = ['korean-diverse-1', 'korean-diverse-5', 'korean-diverse-9', 'korean-diverse-2', 'korean-diverse-6', 'korean-diverse-8', 'korean-diverse-3', 'korean-diverse-4', 'korean-diverse-7', 'korean-diverse-10'];
    for (const project of ['project-a', 'project-b', 'demo', '123']) {
      let hash = 2166136261;
      for (let i = 0; i < project.length; i++) hash = Math.imul(hash ^ project.charCodeAt(i), 16777619);
      expect(distributedKoreanCharacterId(project)).toBe(pool[Math.abs(hash) % pool.length]);
    }
  });
});

describe("expression catalog", () => { it("keeps the replacement ID and seven new expressions selectable", () => { expect(AGENT_CHARACTERS.find(c => c.id === "colleague-distinct-4")?.label).toContain("의구심"); expect(AGENT_CHARACTERS.filter(c => c.id.startsWith("colleague-expression-"))).toHaveLength(7); }); });
