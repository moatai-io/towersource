import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../execution/command-classifier.js';

describe('Docker command classification', () => {
  it.each([
    'docker version',
    'docker info',
    'docker ps',
    'docker images',
    "docker ps --filter label=com.docker.compose.project=tower-frappe-dev --format '{{.Names}}'",
    "docker images --format '{{.Repository}}:{{.Tag}}'",
    'docker inspect tower-box-1',
    "docker inspect tower-box-1 --format '{{.State.Status}}'",
    'docker compose version',
    'docker compose config --services',
    "docker compose ps --format '{{.Name}}'",
    'docker compose images --quiet',
  ])('keeps the explicit read-only diagnostic non-risky: %s', (command) => {
    expect(classifyCommand(command).cls).not.toBe('risky');
  });

  it('allows multiple read-only Docker diagnostics inside a bounded shell probe', () => {
    const command = `set -euo pipefail
printf 'docker=%s\\n' "$(docker version --format '{{.Server.Version}}')"
printf 'compose=%s\\n' "$(docker compose version --short)"`;
    expect(classifyCommand(command).cls).not.toBe('risky');
  });

  it.each([
    'docker run --rm alpine true',
    'docker rm -f tower-box-1',
    'docker system prune -af',
    'docker volume rm data',
    'docker compose down -v',
    'docker exec tower-box-1 sh',
  ])('keeps mutating or unknown Docker operations review-gated: %s', (command) => {
    expect(classifyCommand(command)).toMatchObject({ cls: 'risky' });
  });
});
