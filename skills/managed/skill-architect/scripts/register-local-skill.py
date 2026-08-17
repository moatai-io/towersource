#!/usr/bin/env python3
"""Legacy helper: register a customer-local skill in local-library.yaml.

This is retained only for compatibility with older self-hosted servers that still use
legacy ~/.claude skill catalogs. New Tower-managed skills use repo-owned
`config/skills/managed-skills.yaml` + `skills/managed/<name>/`, and project
runtime skills use `/workspace/.tower/skills/manifest.json`.

This helper intentionally avoids PyYAML so it can run on minimal legacy VMs.
"""
from __future__ import annotations

import argparse
import os
import re
from pathlib import Path


def q(value: str) -> str:
    # YAML double-quoted scalar with minimal escaping.
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


def read_frontmatter_field(text: str, field: str) -> str | None:
    if not text.startswith('---'):
        return None
    end = text.find('\n---', 3)
    if end < 0:
        return None
    fm = text[3:end]
    # Single-line field.
    m = re.search(rf'^{re.escape(field)}:\s*(.+?)\s*$', fm, re.M)
    if not m:
        return None
    raw = m.group(1).strip()
    if raw in {'|', '>'}:
        # Grab the first non-empty indented line after `field: |`.
        after = fm[m.end():].splitlines()
        for line in after:
            if line.startswith(' ') and line.strip():
                return line.strip()
            if line and not line.startswith(' '):
                break
        return None
    return raw.strip('"\'')


def existing_names(yaml_text: str) -> set[str]:
    return set(re.findall(r'^\s*-\s+name:\s+([A-Za-z0-9_-]+)\s*$', yaml_text, re.M))


def render_entry(name: str, owner: str, version: str, description: str, tags: list[str]) -> str:
    tag_lines = ''.join(f'    - {tag}\n' for tag in tags)
    return (
        f'  - name: {name}\n'
        f'    owner: {owner}\n'
        f'    tier: team\n'
        f'    version: {version}\n'
        f'    description: {q(description)}\n'
        f'    tags:\n{tag_lines}'
    )


def main() -> int:
    parser = argparse.ArgumentParser(description='Register a legacy customer-local skill in local-library.yaml')
    parser.add_argument('name', help='skill directory/name, e.g. demo-local-report')
    parser.add_argument('--skills-dir', default=str(Path.home() / '.claude' / 'skills'))
    parser.add_argument('--owner', default=os.environ.get('TOWER_TEAM_SLUG', 'local'))
    parser.add_argument('--tag', action='append', default=[], help='additional tag; may be repeated')
    parser.add_argument('--description', default=None)
    parser.add_argument('--force', action='store_true', help='return success if already registered')
    args = parser.parse_args()

    if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', args.name):
        raise SystemExit('skill name must match: [a-z0-9][a-z0-9-]*')

    skills_dir = Path(args.skills_dir).expanduser()
    skill_file = skills_dir / args.name / 'SKILL.md'
    if not skill_file.exists():
        raise SystemExit(f'SKILL.md not found: {skill_file}')

    text = skill_file.read_text(encoding='utf-8')
    fm_name = read_frontmatter_field(text, 'name')
    if fm_name and fm_name != args.name:
        raise SystemExit(f'frontmatter name mismatch: {fm_name} != {args.name}')

    manifest = skills_dir / '.managed-manifest.json'
    if manifest.exists() and re.search(rf'"{re.escape(args.name)}"\s*:', manifest.read_text(encoding='utf-8')):
        raise SystemExit(f'{args.name} is operator-managed; choose a local-/team-prefixed name')

    library_dir = skills_dir / 'library'
    library_dir.mkdir(parents=True, exist_ok=True)
    local_yaml = library_dir / 'local-library.yaml'

    current = local_yaml.read_text(encoding='utf-8') if local_yaml.exists() else ''
    if args.name in existing_names(current):
        if args.force:
            print(f'already registered: {args.name}')
            return 0
        raise SystemExit(f'already registered in {local_yaml}: {args.name}')

    version = read_frontmatter_field(text, 'version') or '1.0.0'
    description = args.description or read_frontmatter_field(text, 'description') or f'Customer-local skill: {args.name}'
    tags = ['customer-local']
    for tag in args.tag:
        if tag not in tags:
            tags.append(tag)

    entry = render_entry(args.name, args.owner, version, description, tags)
    if not current.strip():
        current = (
            '# Customer-local Tower AI resource catalog.\n'
            '# Managed by /skill-architect on this VM; deploy-profile.sh must not overwrite it.\n'
            'library:\n'
            '  skills:\n'
        )
    elif 'library:' not in current or 'skills:' not in current:
        raise SystemExit(f'unsupported local catalog shape: {local_yaml}')
    if not current.endswith('\n'):
        current += '\n'
    current += entry
    local_yaml.write_text(current, encoding='utf-8')
    print(f'registered customer-local skill: {args.name} -> {local_yaml}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
