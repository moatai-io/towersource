import React, { useEffect, useState } from 'react';
import type { Project } from '@tower/shared';
import { agentPortraitUrl } from './portrait';
import {
  agentFaceImageUrl,
  AgentCharacterAvatar,
  characterFace,
  distributedKoreanCharacterId,
  type AgentAvatarVariant,
} from './characters';

interface AgentIdentityAvatarProps {
  project: Project;
  className?: string;
  fallbackClassName?: string;
  variant?: AgentAvatarVariant;
  showListAccent?: boolean;
}

/** Renders one Project Agent identity with an optional small-list crop treatment. */
export function AgentIdentityAvatar({
  project,
  className = 'h-12 w-12',
  variant = 'default',
  showListAccent = false,
}: AgentIdentityAvatarProps) {
  const characterId = characterFace(project.agent?.face);
  const faceImage = agentFaceImageUrl(project.agent?.face);
  const portrait = agentPortraitUrl(project);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const fallbackId = distributedKoreanCharacterId(project.id);

  useEffect(() => {
    setFailedSource(null);
  }, [faceImage, portrait]);

  if (faceImage && failedSource !== faceImage) {
    if (variant === 'list' && characterId) {
      return <AgentCharacterAvatar id={characterId} className={className} variant="list" showListAccent={showListAccent} title={project.agent?.displayName || project.name} />;
    }
    return (
      <img
        src={faceImage}
        alt=""
        className={`${className} aspect-square max-w-none object-cover`}
        loading={variant === 'list' ? 'lazy' : undefined}
        decoding="async"
        onError={() => setFailedSource(faceImage)}
        aria-hidden="true"
      />
    );
  }

  if (portrait && failedSource !== portrait) {
    return (
      <span className={`${className} relative inline-block overflow-hidden`}>
        <img
          src={portrait}
          alt=""
          className={`h-full w-full max-w-none object-cover ${variant === 'list' ? 'scale-[1.3] origin-[50%_34%]' : ''}`}
          loading={variant === 'list' ? 'lazy' : undefined}
          decoding="async"
          onError={() => setFailedSource(portrait)}
          aria-hidden="true"
        />
      </span>
    );
  }

  return (
    <AgentCharacterAvatar
      id={fallbackId}
      className={className}
      variant={variant}
      showListAccent={showListAccent}
      title={project.agent?.displayName || project.name}
    />
  );
}
