/**
 * Owns: voice-only turn buffering and the boundary between listening and thinking.
 * Public API: VoiceTurnOrchestrator.
 * See README.md and _DECISIONS.md.
 */

export type VoiceTurnState = 'listening' | 'thinking' | 'speaking';

export interface VoiceTranscriptAppendResult {
  superseded: boolean;
  transcript: string;
}

/**
 * Buffers adjacent STT finals and distinguishes continued speech from a new turn.
 * A request is superseded only after the user resumed speaking during thinking and
 * another final transcript confirms that this was real speech rather than noise.
 */
export class VoiceTurnOrchestrator {
  static readonly DEFAULT_SILENCE_MS = 1_300;

  private readonly transcriptParts: string[] = [];
  private state: VoiceTurnState = 'listening';
  private userResumedDuringThinking = false;

  /** Add one final STT segment to the current spoken input. */
  appendFinalTranscript(transcript: string, requestActive: boolean): VoiceTranscriptAppendResult {
    const normalized = transcript.trim();
    if (!normalized) return { superseded: false, transcript: '' };

    const superseded = requestActive
      && this.state === 'thinking'
      && this.userResumedDuringThinking;
    if (superseded) {
      this.transcriptParts.length = 0;
      this.state = 'listening';
      this.userResumedDuringThinking = false;
    }
    this.transcriptParts.push(normalized);
    return { superseded, transcript: normalized };
  }

  /** Mark the turn as being sent to Tower for reasoning. */
  markThinking(): void {
    this.state = 'thinking';
    this.userResumedDuringThinking = false;
  }

  /** Record that the user resumed speaking while Tower is reasoning. */
  markUserSpeaking(): void {
    if (this.state === 'thinking') this.userResumedDuringThinking = true;
  }

  /** Mark that the first spoken response has started. */
  markSpeaking(): void {
    this.state = 'speaking';
    this.userResumedDuringThinking = false;
  }

  /** Return whether a complete buffered input is waiting to be processed. */
  hasPendingTranscript(): boolean {
    return this.transcriptParts.length > 0;
  }

  /** Take the current buffered input as one turn. */
  takeTranscript(): string {
    const transcript = this.transcriptParts.splice(0).join(' ');
    this.state = 'thinking';
    this.userResumedDuringThinking = false;
    return transcript;
  }

  /** Reset the current voice turn, normally on room close. */
  clear(): void {
    this.transcriptParts.length = 0;
    this.state = 'listening';
    this.userResumedDuringThinking = false;
  }

  /** Expose the current state for diagnostics and future TTS playback hooks. */
  getState(): VoiceTurnState {
    return this.state;
  }
}
