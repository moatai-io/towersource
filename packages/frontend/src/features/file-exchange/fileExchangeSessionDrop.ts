// Owns: the lazy chat-composer entry point for File Exchange session drops.
import { transferFile } from './fileExchange';
import { decodeExchangeDrag, type ExchangeDestinationRef, type ExchangeDragPayload } from './fileExchangeDrag';

export interface SessionDropTransfer {
  payload: ExchangeDragPayload;
  receipt: Awaited<ReturnType<typeof transferFile>>;
}

/** Keep the chat composer lazy boundary on one entry module, even when file surfaces use the underlying clients eagerly. */
export async function transferSessionDrop(raw: string, sessionId: string): Promise<SessionDropTransfer | null> {
  const payload = decodeExchangeDrag(raw);
  if (!payload) return null;

  const destination: ExchangeDestinationRef = { scope: 'session', sessionId };
  const receipt = await transferFile(payload.source, destination, async () => true);
  return { payload, receipt };
}
