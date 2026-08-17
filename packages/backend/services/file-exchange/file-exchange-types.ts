// Owns: public File Exchange contracts. Public API: typed refs, plans, results. See README.md.

export type FileExchangePrincipal =
  | { kind: 'user' }
  | { kind: 'agent'; projectId: string; sessionId: string; profileVersion: number | null };

export interface FileExchangeActor {
  userId: number;
  role: string;
  principal?: FileExchangePrincipal;
}

export type FileSourceRef =
  | { scope: 'personal'; uri: string }
  | { scope: 'session'; sessionId: string; attachmentId: string }
  | { scope: 'channel'; channelId: string; fileId: string }
  | { scope: 'project'; projectId: string; relativePath: string };

export type FileDestinationRef =
  | { scope: 'personal'; relativeDirectory?: string }
  | { scope: 'session'; sessionId: string }
  | { scope: 'channel'; channelId: string }
  | { scope: 'project'; projectId: string; relativeDirectory?: string };

export type FileTransferMode = 'snapshot' | 'workspace_copy';

export interface FileTransferIntent {
  source: FileSourceRef;
  destination: FileDestinationRef;
}

export interface FileTransferPlan {
  id: string;
  source: FileSourceRef;
  destination: FileDestinationRef;
  mode: FileTransferMode;
  sourceName: string;
  sourceMimeType: string | null;
  sourceSizeBytes: number;
  confirmationRequired: boolean;
  confirmationMessage: string | null;
  expiresAt: string;
}

export interface FileTransferReceipt {
  id: string;
  planId: string;
  principal: FileExchangePrincipal;
  delegatedByUserId: number;
  source: FileSourceRef;
  destination: FileDestinationRef;
  result: Record<string, unknown> | null;
  mode: FileTransferMode;
  status: 'completed' | 'failed' | 'denied' | 'stale';
  failureCode: string | null;
  failureStage: string | null;
  createdAt: string;
}

export class FileExchangeError extends Error {
  constructor(
    public code: 'INVALID' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFIRMATION_REQUIRED' | 'STALE' | 'CONFLICT' | 'FAILED',
    message: string,
    public stage?: string,
  ) {
    super(message);
    this.name = 'FileExchangeError';
  }
}
