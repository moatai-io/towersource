/**
 * Owns: file-backed live meeting recorder MVP.
 * Public API: createMeetingRun, appendMeetingChunk, getMeetingRun.
 * See AGENTS.md for Tower workspace output conventions.
 */
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../../config.js';

export type MeetingAudioSource = 'mic' | 'tab-audio' | 'mixed' | 'upload';

export interface MeetingRunRecord {
  id: string;
  title: string;
  source: MeetingAudioSource;
  language: string;
  status: 'live' | 'ended';
  createdAt: string;
  updatedAt: string;
  dir: string;
  markdownPath: string;
  transcriptPath: string;
  audioDir: string;
  saveAudio: boolean;
}

export interface MeetingChunkInput {
  startMs: number;
  endMs: number;
  transcriptText?: string;
  mimeType?: string;
  audio?: Buffer;
  originalName?: string;
}

interface MeetingSegmentRecord {
  id: string;
  runId: string;
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  hasAudio: boolean;
  audioPath?: string;
  mimeType?: string;
  createdAt: string;
}

export const MEETING_RECORDER_PROJECT_ROOT = path.join(config.workspaceRoot, 'projects', 'tower');
const DEFAULT_RUNS_ROOT = path.join(MEETING_RECORDER_PROJECT_ROOT, 'work', 'meeting-live', 'runs');

function runsRoot(projectRoot?: string): string {
  return path.join(projectRoot || MEETING_RECORDER_PROJECT_ROOT, 'work', 'meeting-live', 'runs');
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s_-]+/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
  return slug || 'meeting';
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function safeRunDir(id: string, projectRoot?: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('invalid meeting run id');
  return path.join(projectRoot ? runsRoot(projectRoot) : DEFAULT_RUNS_ROOT, id);
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function readSegments(transcriptPath: string): Promise<MeetingSegmentRecord[]> {
  try {
    const raw = await fs.readFile(transcriptPath, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MeetingSegmentRecord);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

function renderMarkdown(run: MeetingRunRecord, segments: MeetingSegmentRecord[]): string {
  const last = segments.at(-1);
  const transcriptLines = segments.map((seg) => {
    const text = seg.text || '_전사 텍스트 없음 — 오디오 chunk만 캡처됨_';
    return `- **${formatDuration(seg.startMs)}–${formatDuration(seg.endMs)}** ${text}`;
  });
  const recentLines = segments.slice(-12).map((seg) => {
    const text = seg.text || '_전사 대기_';
    return `- ${formatDuration(seg.startMs)} ${text}`;
  });

  return `# ${run.title}\n\n` +
    `- run_id: ${run.id}\n` +
    `- status: ${run.status}\n` +
    `- source: ${run.source}\n` +
    `- language: ${run.language}\n` +
    `- created: ${run.createdAt}\n` +
    `- updated: ${run.updatedAt}\n` +
    `- chunks: ${segments.length}\n` +
    `- latest_window: ${last ? `${formatDuration(last.startMs)}–${formatDuration(last.endMs)}` : 'none'}\n\n` +
    `## How to use\n\n` +
    `이 파일은 Tower Meeting Recorder MVP가 갱신하는 라이브 회의 메모입니다. 에이전트는 3~4분마다 이 파일을 읽고 결정, 열린 질문, 액션아이템, 리스크를 추출하면 됩니다.\n\n` +
    `## Recent window\n\n` +
    `${recentLines.length ? recentLines.join('\n') : '_아직 캡처된 transcript가 없습니다._'}\n\n` +
    `## Running transcript\n\n` +
    `${transcriptLines.length ? transcriptLines.join('\n') : '_아직 캡처된 transcript가 없습니다._'}\n\n` +
    `## Agent scratchpad\n\n` +
    `- Decisions: TBD\n` +
    `- Open questions: TBD\n` +
    `- Action items: TBD\n` +
    `- Risks/watchpoints: TBD\n`;
}

async function refreshMarkdown(run: MeetingRunRecord): Promise<void> {
  const segments = await readSegments(run.transcriptPath);
  const tmp = `${run.markdownPath}.tmp`;
  await fs.writeFile(tmp, renderMarkdown(run, segments), 'utf8');
  await fs.rename(tmp, run.markdownPath);
}

export async function createMeetingRun(input: {
  title?: string;
  source?: MeetingAudioSource;
  language?: string;
  saveAudio?: boolean;
  projectRoot?: string;
}): Promise<MeetingRunRecord> {
  const now = new Date().toISOString();
  const title = input.title?.trim() || `Live Meeting ${now.slice(0, 16).replace('T', ' ')}`;
  const id = `${now.slice(0, 10)}-${slugify(title)}-${randomUUID().slice(0, 8)}`;
  const dir = safeRunDir(id, input.projectRoot);
  const audioDir = path.join(dir, 'audio-chunks');
  const run: MeetingRunRecord = {
    id,
    title,
    source: input.source || 'mic',
    language: input.language || 'ko-KR',
    status: 'live',
    createdAt: now,
    updatedAt: now,
    dir,
    markdownPath: path.join(dir, 'live-meeting.md'),
    transcriptPath: path.join(dir, 'raw-transcript.jsonl'),
    audioDir,
    saveAudio: input.saveAudio !== false,
  };
  await fs.mkdir(audioDir, { recursive: true });
  await writeJson(path.join(dir, 'run.json'), run);
  await fs.writeFile(run.transcriptPath, '', 'utf8');
  await refreshMarkdown(run);
  return run;
}

export async function getMeetingRun(id: string): Promise<MeetingRunRecord & { segments: MeetingSegmentRecord[] }> {
  const dir = safeRunDir(id);
  const run = await readJson<MeetingRunRecord>(path.join(dir, 'run.json'));
  const segments = await readSegments(run.transcriptPath);
  return { ...run, segments };
}

export async function appendMeetingChunk(id: string, input: MeetingChunkInput): Promise<{ run: MeetingRunRecord; segment: MeetingSegmentRecord; markdown: string }> {
  const dir = safeRunDir(id);
  const metaPath = path.join(dir, 'run.json');
  const run = await readJson<MeetingRunRecord>(metaPath);
  const existing = await readSegments(run.transcriptPath);
  const index = existing.length + 1;
  let audioPath: string | undefined;
  if (run.saveAudio && input.audio?.length) {
    const ext = input.mimeType?.includes('mp4') ? 'mp4' : input.mimeType?.includes('wav') ? 'wav' : 'webm';
    audioPath = path.join(run.audioDir, `${String(index).padStart(5, '0')}.${ext}`);
    await fs.writeFile(audioPath, input.audio);
  }
  const segment: MeetingSegmentRecord = {
    id: randomUUID(),
    runId: id,
    index,
    startMs: Number.isFinite(input.startMs) ? Math.max(0, Math.floor(input.startMs)) : 0,
    endMs: Number.isFinite(input.endMs) ? Math.max(0, Math.floor(input.endMs)) : 0,
    text: input.transcriptText?.trim() || '',
    hasAudio: !!input.audio?.length,
    audioPath,
    mimeType: input.mimeType,
    createdAt: new Date().toISOString(),
  };
  await fs.appendFile(run.transcriptPath, `${JSON.stringify(segment)}\n`, 'utf8');
  const updatedRun = { ...run, updatedAt: segment.createdAt };
  await writeJson(metaPath, updatedRun);
  await refreshMarkdown(updatedRun);
  return { run: updatedRun, segment, markdown: updatedRun.markdownPath };
}

export async function endMeetingRun(id: string): Promise<MeetingRunRecord> {
  const dir = safeRunDir(id);
  const metaPath = path.join(dir, 'run.json');
  const run = await readJson<MeetingRunRecord>(metaPath);
  const updated = { ...run, status: 'ended' as const, updatedAt: new Date().toISOString() };
  await writeJson(metaPath, updated);
  await refreshMarkdown(updated);
  return updated;
}
