import React from 'react';
import characterManifest from '../../../public/agent-characters/manifest.json';

export interface AgentCharacterListCrop {
  scale: number;
  x: number;
  y: number;
}

export interface AgentCharacter {
  id: string;
  label: string;
  group: 'core' | 'korean';
  src: string;
  listCrop?: AgentCharacterListCrop;
  listAccent?: string;
}

export type AgentAvatarVariant = 'default' | 'list';

export const AGENT_CHARACTERS: AgentCharacter[] = characterManifest.characters.map((character) => ({
  ...character,
  group: character.group as AgentCharacter['group'],
  src: `/agent-characters/${character.file}`,
}));

const KOREAN_CHARACTER_IDS = AGENT_CHARACTERS.filter((item) => item.id.startsWith('korean-')).map((item) => item.id);

export function characterFace(id: string | undefined | null): string | null {
  return id?.startsWith('character:') ? id.slice(10) : null;
}

export function distributedKoreanCharacterId(projectId: string): string {
  let hash = 2166136261;
  for (let index = 0; index < projectId.length; index++) {
    hash ^= projectId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return KOREAN_CHARACTER_IDS[Math.abs(hash) % KOREAN_CHARACTER_IDS.length] || AGENT_CHARACTERS[0]?.id || 'core-talent';
}

export function generatedCharacterFace(id: string | undefined | null): string | null {
  return id?.startsWith('generated:') ? id.slice(10) : null;
}

export function agentFaceImageUrl(face: string | undefined | null): string | null {
  const generated = generatedCharacterFace(face);
  if (generated) return `/api/agent-characters/generated/${generated}`;
  const character = characterFace(face);
  return character ? AGENT_CHARACTERS.find((item) => item.id === character)?.src || null : null;
}

/** Returns the small-list crop and identity accent for curated character assets. */
export function agentCharacterListPresentation(id: string | undefined | null): { crop?: AgentCharacterListCrop; accent?: string } {
  const character = id ? AGENT_CHARACTERS.find((item) => item.id === id) : undefined;
  return { crop: character?.listCrop, accent: character?.listAccent };
}

export function AgentCharacterAvatar({ id, className = 'h-16 w-16', title, variant = 'default', showListAccent = false }: { id: string; className?: string; title?: string; variant?: AgentAvatarVariant; showListAccent?: boolean }) {
  const character = AGENT_CHARACTERS.find((item) => item.id === id) || AGENT_CHARACTERS[0];
  const fallbackCharacter = AGENT_CHARACTERS[0];
  const [failedSources, setFailedSources] = React.useState<string[]>([]);
  const visibleCharacter = failedSources.includes(character.src) && fallbackCharacter ? fallbackCharacter : character;
  const imageUnavailable = failedSources.includes(visibleCharacter.src);
  const listPresentation = variant === 'list' ? agentCharacterListPresentation(visibleCharacter.id) : {};
  const cropStyle = listPresentation.crop
    ? { transform: `scale(${listPresentation.crop.scale})`, transformOrigin: `${listPresentation.crop.x}% ${listPresentation.crop.y}%` }
    : undefined;
  const ringStyle = variant === 'list' && showListAccent && listPresentation.accent
    ? { boxShadow: `0 0 0 1.5px ${listPresentation.accent}` }
    : undefined;

  React.useEffect(() => {
    setFailedSources([]);
  }, [character.src]);

  return (
    <span className={`${className} relative inline-block overflow-hidden`} style={ringStyle}>
      {imageUnavailable ? (
        <span className="grid h-full w-full place-items-center text-[0.65em] font-semibold text-surface-300" aria-label={title || 'AI 팀원'}>
          {(title || 'AI').trim().slice(0, 1).toUpperCase()}
        </span>
      ) : (
        <img
          src={visibleCharacter.src}
          alt={title || ''}
          className="h-full w-full max-w-none object-cover"
          style={cropStyle}
          loading={variant === 'list' ? 'lazy' : undefined}
          decoding="async"
          onError={() => setFailedSources((prev) => prev.includes(visibleCharacter.src) ? prev : [...prev, visibleCharacter.src])}
          aria-hidden={title ? undefined : true}
        />
      )}
    </span>
  );
}
