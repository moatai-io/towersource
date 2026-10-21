// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentIdentityAvatar } from './AgentIdentityAvatar';
import { AgentCharacterAvatar } from './characters';

function project(face: string) {
  return {
    id: 'project-avatar-fallback',
    name: '테스트 팀원',
    agent: { face, displayName: '테스트 팀원' },
  } as any;
}

describe('AgentIdentityAvatar resilience', () => {
  it('does not paint a rectangular background behind transparent portraits', () => {
    for (const variant of ['default', 'list'] as const) {
      const { container, unmount } = render(<AgentIdentityAvatar project={project('character:korean-diverse-1')} variant={variant} />);
      const frame = container.querySelector('img')?.parentElement;
      expect(frame).toBeTruthy();
      expect(frame?.className).not.toContain('bg-surface-800');
      expect(frame?.style.boxShadow).toBe('');
      unmount();
    }
  });

  it('accepts partial project data without a name during session switching', () => {
    const partialProject = { id: 'partial-project', agent: { face: 'generated:ready' } } as any;
    expect(() => render(<AgentIdentityAvatar project={partialProject} variant="list" />)).not.toThrow();
  });

  it('falls back to a curated character when a generated image fails', () => {
    const { container } = render(<AgentIdentityAvatar project={project('generated:missing')} variant="list" />);
    const generated = container.querySelector('img[src="/api/agent-characters/generated/missing"]');
    expect(generated).not.toBeNull();
    fireEvent.error(generated!);
    const fallback = container.querySelector('img[src^="/agent-characters/"]');
    expect(fallback).not.toBeNull();
  });

  it('uses lazy async decoding for list avatars', () => {
    const { container } = render(<AgentIdentityAvatar project={project('generated:ready')} variant="list" />);
    const image = container.querySelector('img');
    expect(image?.getAttribute('loading')).toBe('lazy');
    expect(image?.getAttribute('decoding')).toBe('async');
  });

  it('keeps a text fallback if curated assets also fail', async () => {
    const { container } = render(<AgentIdentityAvatar project={project('character:korean-diverse-1')} variant="list" />);
    const primary = container.querySelector('img');
    expect(primary).not.toBeNull();
    fireEvent.error(primary!);
    const fallbackImage = await waitFor(() => {
      const image = container.querySelector('img[src^="/agent-characters/core-"]');
      expect(image).not.toBeNull();
      return image!;
    });
    fireEvent.error(fallbackImage);
    await waitFor(() => {
      const textFallback = container.querySelector('[aria-label="테스트 팀원"]');
      expect(textFallback?.textContent).toBe('테');
    });
  });
});

 describe('discovery character framing', () => {
  it('does not add colored rings when a discovery caller omits the accent prop', () => {
    const { container } = render(<AgentCharacterAvatar id="korean-diverse-1" variant="list" />);
    expect(container.querySelector('img')?.parentElement?.style.boxShadow).toBe('');
  });
  it('preserves an explicitly requested accent', () => {
    const { container } = render(<AgentCharacterAvatar id="korean-diverse-1" variant="list" showListAccent />);
    expect(container.querySelector('img')?.parentElement?.style.boxShadow).toContain('1.5px');
  });
 });
