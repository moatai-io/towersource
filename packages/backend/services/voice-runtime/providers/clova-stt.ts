/**
 * Owns: NAVER CLOVA Speech bidirectional gRPC streaming adapter.
 * Public API: ClovaStreamingStt. See ../README.md.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const protoPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'clova-nest.proto');
const definition = protoLoader.loadSync(protoPath, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const loaded = grpc.loadPackageDefinition(definition) as any;
const NestService = loaded.com.nbp.cdncp.nest.grpc.proto.v1.NestService;

export interface ClovaStreamingSttOptions {
  secretKey: string;
  endpoint?: string;
  language?: 'ko-KR';
  keywordBoosting?: string[];
}

export interface ClovaTranscriptEvent {
  text: string;
  final: boolean;
  raw: unknown;
}

function parseContents(contents: string): ClovaTranscriptEvent | null {
  try {
    const raw = JSON.parse(contents);
    const text = String(raw?.text ?? raw?.transcription?.text ?? raw?.result?.text ?? '').trim();
    if (!text) return null;
    const final = Boolean(raw?.final ?? raw?.isFinal ?? raw?.transcription?.final ?? raw?.result?.final);
    return { text, final, raw };
  } catch {
    return contents.trim() ? { text: contents.trim(), final: false, raw: contents } : null;
  }
}

/** Opens one 16kHz mono PCM stream and yields partial/final Korean transcript events. */
export class ClovaStreamingStt {
  constructor(private readonly options: ClovaStreamingSttOptions) {}

  async *recognize(audio: AsyncIterable<Uint8Array>, signal?: AbortSignal): AsyncIterable<ClovaTranscriptEvent> {
    const credentials = grpc.credentials.createSsl();
    const client = new NestService(this.options.endpoint ?? 'clovaspeech-gw.ncloud.com:50051', credentials);
    const metadata = new grpc.Metadata();
    metadata.set('authorization', `Bearer ${this.options.secretKey}`);
    const call = client.recognize(metadata);

    const config = JSON.stringify({
      transcription: { language: this.options.language ?? 'ko-KR' },
      ...(this.options.keywordBoosting?.length
        ? { keywordBoosting: { keywords: this.options.keywordBoosting } }
        : {}),
    });
    call.write({ type: 'CONFIG', config: { config } });

    const abort = () => call.cancel();
    signal?.addEventListener('abort', abort, { once: true });
    const writer = (async () => {
      try {
        for await (const chunk of audio) {
          if (signal?.aborted) break;
          if (!call.write({ type: 'DATA', data: { chunk: Buffer.from(chunk), extra_contents: '' } })) {
            await new Promise<void>((resolve) => call.once('drain', resolve));
          }
        }
        call.end();
      } catch (error) {
        call.destroy(error as Error);
      }
    })();

    try {
      for await (const response of call as AsyncIterable<{ contents: string }>) {
        const event = parseContents(response.contents);
        if (event) yield event;
      }
      await writer;
    } finally {
      signal?.removeEventListener('abort', abort);
      client.close();
    }
  }
}
