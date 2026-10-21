/** Owns voice-only input revisions; sending input never consumes its source segments. */
export type VoiceTurnState = 'listening' | 'thinking' | 'speaking';

export interface VoiceTranscriptAppendResult {
  superseded: boolean;
  transcript: string;
  revision: number;
}

export interface VoiceInputRevision {
  readonly transcript: string;
  readonly revision: number;
  /** Original STT finals, including their original spacing. */
  readonly segments: readonly string[];
}

export class VoiceTurnOrchestrator {
  static readonly DEFAULT_SILENCE_MS = 1_300;

  private readonly transcriptParts: string[] = [];
  private state: VoiceTurnState = 'listening';
  private revision = 0;
  private pending = false;
  private responseStarted = false;

  appendFinalTranscript(transcript: string, requestActive: boolean): VoiceTranscriptAppendResult {
    const normalized = transcript.trim();
    if (!normalized) return { superseded: false, transcript: '', revision: this.revision };
    // A final is itself evidence of continued speech, even if VAD's start was lost.
    // Only actual output start (not say/queueing) separates the next question.
    const superseded = requestActive && !this.responseStarted;
    if (this.responseStarted) {
      this.transcriptParts.length = 0;
      this.responseStarted = false;
    }
    this.transcriptParts.push(transcript);
    this.revision += 1;
    this.pending = true;
    this.state = 'listening';
    return { superseded, transcript: normalized, revision: this.revision };
  }

  markThinking(): void { this.state = 'thinking'; }
  markUserSpeaking(): void { /* VAD scheduling is owned by VoiceWorkerController. */ }

  /** Called on SDK output start, never when speech is only queued. */
  markSpeaking(): void {
    this.state = 'speaking';
    this.responseStarted = true;
  }

  markPlaybackFinished(): void {
    this.state = 'listening';
    // Keep responseStarted until the next final, including after playout ends.
  }

  hasPendingTranscript(): boolean { return this.pending; }
  getRevision(): number { return this.revision; }
  hasStartedResponse(): boolean { return this.responseStarted; }

  takeInput(): VoiceInputRevision {
    this.pending = false;
    this.state = 'thinking';
    return Object.freeze({
      transcript: this.transcriptParts.map((part) => part.trim()).join(' '),
      revision: this.revision,
      segments: Object.freeze([...this.transcriptParts]),
    });
  }

  takeTranscript(): string { return this.takeInput().transcript; }

  clear(): void {
    this.transcriptParts.length = 0;
    this.pending = false;
    this.responseStarted = false;
    this.state = 'listening';
  }

  getState(): VoiceTurnState { return this.state; }
}
