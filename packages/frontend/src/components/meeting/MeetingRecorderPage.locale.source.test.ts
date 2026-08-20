import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'MeetingRecorderPage.tsx'), 'utf8');

describe('MeetingRecorderPage locale contract', () => {
  it('routes recording controls, errors, logs, and empty states through locale keys', () => {
    for (const key of [
      'meetingRecorder.error.noAudioTrack',
      'meetingRecorder.defaultTitle',
      'meetingRecorder.log.chunkSaved',
      'meetingRecorder.captureSource',
      'meetingRecorder.manualTranscript',
      'meetingRecorder.noLogs',
    ]) expect(source).toContain(key);
  });

  it('preserves the Korean recording language contract for the current MVP', () => {
    expect(source).toContain("language: 'ko-KR'");
  });
});
