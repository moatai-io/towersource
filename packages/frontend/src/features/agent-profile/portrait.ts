import type { Project } from '@tower/shared';
import { characterFace } from './characters';

const PORTRAITS = {
  talent: '/agent-portraits/ai-talent-partner.webp',
  company: '/agent-portraits/company-profile-editor.webp',
  tower: '/agent-portraits/tower-product-engineer.webp',
} as const;

export function agentPortraitUrl(project: Project): string | null {
  if (characterFace(project.agent?.face)) return null;
  const projectName = typeof project.name === 'string' ? project.name.trim() : '';
  if (project.systemKey === 'ai-talent-team') return PORTRAITS.talent;
  if (/^회사소개서(?:\s*AI)?$/i.test(projectName)) return PORTRAITS.company;
  if (/^Tower\s*제품\s*개발$/i.test(projectName)) return PORTRAITS.tower;
  return null;
}
