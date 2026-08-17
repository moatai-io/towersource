-- Space 테이블
CREATE TABLE IF NOT EXISTS spaces (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT,
  type        TEXT NOT NULL DEFAULT 'custom',
  color       TEXT DEFAULT '#6b7280',
  icon        TEXT DEFAULT 'folder',
  sort_order  INTEGER DEFAULT 0,
  archived    INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- type 값: 'client', 'research', 'internal', 'personal', 'custom'
-- icon 값: Lucide 아이콘명 (예: 'building-2', 'flask-conical', 'home', 'user')

-- projects 테이블에 space_id 추가
ALTER TABLE projects ADD COLUMN IF NOT EXISTS space_id INTEGER REFERENCES spaces(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_projects_space_id ON projects(space_id);

-- 기본 Space 생성
INSERT INTO spaces (name, slug, type, color, icon, sort_order) VALUES
  ('클라이언트', 'clients', 'client', '#3b82f6', 'building-2', 1),
  ('리서치', 'research', 'research', '#8b5cf6', 'flask-conical', 2),
  ('내부', 'internal', 'internal', '#10b981', 'home', 3)
ON CONFLICT (slug) DO NOTHING;
