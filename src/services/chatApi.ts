import type { AssistantMode, AttachmentItem, ChatMessage, WebSource } from '../types/chat';

const MAX_CLIENT_HISTORY_TURNS = 10;
const MAX_CLIENT_HISTORY_CHARS = 6000;
const MAX_SINGLE_MESSAGE_CHARS = 1500;
const FAST_TIMEOUT_MS = 28000;
const EXTENDED_TIMEOUT_MS = 45000;

export class ChatApiError extends Error {
  code: string;
  status: number;
  retryable: boolean;

  constructor(message: string, code = 'API_ERROR', status = 500, retryable = true) {
    super(message);
    this.name = 'ChatApiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

interface StreamChatParams {
  message: string;
  history: Pick<ChatMessage, 'role' | 'content' | 'isError'>[];
  mode?: AssistantMode;
  attachments?: AttachmentItem[];
  memories?: string[];
  signal?: AbortSignal;
  onThought?: (accumulatedThoughts: string) => void;
  onChunk: (accumulatedText: string, delta: string) => void;
  onSources?: (sources: WebSource[]) => void;
}

function buildCompactHistory(
  history: Pick<ChatMessage, 'role' | 'content' | 'isError'>[]
): { role: string; content: string }[] {
  const valid = history.filter((m) => !m.isError && m.content.trim().length > 0);
  const recent = valid.slice(-MAX_CLIENT_HISTORY_TURNS);
  const selectedReversed: { role: string; content: string }[] = [];
  let charBudget = MAX_CLIENT_HISTORY_CHARS;

  for (let i = recent.length - 1; i >= 0; i--) {
    let text = recent[i].content.trim();
    if (text.length > MAX_SINGLE_MESSAGE_CHARS) {
      text = `${text.slice(0, MAX_SINGLE_MESSAGE_CHARS)}…`;
    }
    if (charBudget - text.length < 0 && selectedReversed.length > 0) {
      break;
    }
    selectedReversed.push({ role: recent[i].role, content: text });
    charBudget -= text.length;
  }

  return selectedReversed.reverse();
}

export async function streamChatResponse({
  message,
  history,
  mode = 'fast',
  attachments,
  memories,
  signal,
  onThought,
  onChunk,
  onSources,
}: StreamChatParams): Promise<{ text: string; thoughts: string; sources: WebSource[] }> {
  const compactHistory = buildCompactHistory(history);
  const outboundAttachments = attachments?.map((att) => ({
    name: att.name,
    mimeType: att.mimeType,
    kind: att.kind,
    dataBase64: att.dataBase64,
    textContent: att.textContent,
  }));

  const timeoutMs =
    mode === 'think' || mode === 'search' || (outboundAttachments?.length ?? 0) > 0
      ? EXTENDED_TIMEOUT_MS
      : FAST_TIMEOUT_MS;

  const timeoutController = new AbortController();
  let timedOut = false;

  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs);

  const handleCallerAbort = () => {
    timeoutController.abort();
  };

  if (signal) {
    if (signal.aborted) {
      window.clearTimeout(timeoutId);
      throw new DOMException('Aborted', 'AbortError');
    }
    signal.addEventListener('abort', handleCallerAbort, { once: true });
  }

  let response: Response;
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        history: compactHistory,
        mode,
        attachments: outboundAttachments,
        memories,
      }),
      signal: timeoutController.signal,
    });
  } catch (err) {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', handleCallerAbort);

    if (timedOut) {
      throw new ChatApiError(
        'The request timed out while waiting for Gemini. Please try again.',
        'TIMEOUT',
        504,
        true
      );
    }
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    throw new ChatApiError(
      'Network connection failed. Please check your internet connection and try again.',
      'NETWORK_ERROR',
      0,
      true
    );
  }

  if (!response.ok) {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', handleCallerAbort);

    let errorMessage =
      response.status === 404
        ? 'Chat API endpoint (/api/chat) was not found. Please refresh the page or ensure the app server is running.'
        : `Request failed with status ${response.status}.`;
    let errorCode = response.status === 404 ? 'ENDPOINT_NOT_FOUND' : 'HTTP_ERROR';
    let retryable = response.status >= 500 || response.status === 429 || response.status === 404;

    try {
      const payload = (await response.json()) as {
        error?: string;
        code?: string;
        retryable?: boolean;
      };
      if (payload.error) errorMessage = payload.error;
      if (payload.code) errorCode = payload.code;
      if (typeof payload.retryable === 'boolean') retryable = payload.retryable;
    } catch {
      // Non-JSON response body
    }

    throw new ChatApiError(errorMessage, errorCode, response.status, retryable);
  }

  if (!response.body) {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', handleCallerAbort);
    throw new ChatApiError('Server returned an empty response stream.', 'EMPTY_STREAM', 500, true);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulatedText = '';
  let accumulatedThoughts = '';
  let collectedSources: WebSource[] = [];

  const processPayload = (payload: {
    text?: string;
    thought?: string;
    sources?: WebSource[];
    done?: boolean;
    error?: string;
    code?: string;
    retryable?: boolean;
  }) => {
    if (payload.error) {
      throw new ChatApiError(
        payload.error,
        payload.code ?? 'STREAM_ERROR',
        500,
        payload.retryable ?? true
      );
    }

    if (typeof payload.thought === 'string' && payload.thought.length > 0) {
      accumulatedThoughts += payload.thought;
      onThought?.(accumulatedThoughts);
    }

    if (typeof payload.text === 'string' && payload.text.length > 0) {
      accumulatedText += payload.text;
      onChunk(accumulatedText, payload.text);
    }

    if (Array.isArray(payload.sources) && payload.sources.length > 0) {
      collectedSources = payload.sources;
      onSources?.(collectedSources);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const rawEvent of events) {
        const lines = rawEvent.split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonText = line.slice(6).trim();
          if (!jsonText) continue;

          let parsed: Parameters<typeof processPayload>[0];
          try {
            parsed = JSON.parse(jsonText);
          } catch {
            continue;
          }
          processPayload(parsed);
        }
      }
    }

    if (buffer.trim().startsWith('data: ')) {
      const jsonText = buffer.trim().slice(6).trim();
      try {
        const parsed = JSON.parse(jsonText) as Parameters<typeof processPayload>[0];
        processPayload(parsed);
      } catch (err) {
        if (err instanceof ChatApiError) throw err;
      }
    }

    return {
      text: accumulatedText,
      thoughts: accumulatedThoughts,
      sources: collectedSources,
    };
  } catch (err) {
    if (timedOut) {
      throw new ChatApiError(
        'The response stream timed out. Please try again.',
        'TIMEOUT',
        504,
        true
      );
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', handleCallerAbort);
  }
}

export async function synthesizeSpeech(
  text: string,
  signal?: AbortSignal
): Promise<{ audioDataUrl: string }> {
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`TTS failed with status ${res.status}`);
  }

  const data = (await res.json()) as { audioBase64?: string; mimeType?: string };
  if (!data.audioBase64) {
    throw new Error('Empty audio payload');
  }

  return {
    audioDataUrl: `data:${data.mimeType || 'audio/wav'};base64,${data.audioBase64}`,
  };
}

export async function generateImageRequest({
  prompt,
  aspectRatio = '1:1',
  sourceImage,
  signal,
}: {
  prompt: string;
  aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
  sourceImage?: { dataBase64: string; mimeType: string };
  signal?: AbortSignal;
}): Promise<{
  imageBase64: string;
  mimeType: string;
  dataUrl: string;
  caption?: string;
  model?: string;
  provider?: string;
  aspectRatio: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
}> {
  const timeoutController = new AbortController();
  let timedOut = false;
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, 35000);

  const handleCallerAbort = () => timeoutController.abort();
  if (signal) {
    if (signal.aborted) {
      window.clearTimeout(timeoutId);
      throw new DOMException('Aborted', 'AbortError');
    }
    signal.addEventListener('abort', handleCallerAbort, { once: true });
  }

  let response: Response;
  try {
    response = await fetch('/api/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, aspectRatio, sourceImage }),
      signal: timeoutController.signal,
    });
  } catch (err) {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', handleCallerAbort);
    if (timedOut) {
      throw new ChatApiError(
        'Image generation timed out. Please try again.',
        'TIMEOUT',
        504,
        true
      );
    }
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    throw new ChatApiError(
      'Network connection failed while generating image.',
      'NETWORK_ERROR',
      0,
      true
    );
  } finally {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', handleCallerAbort);
  }

  if (!response.ok) {
    let errorMessage =
      response.status === 404
        ? 'Image API endpoint (/api/image) was not found.'
        : `Image request failed with status ${response.status}.`;
    let errorCode = response.status === 404 ? 'ENDPOINT_NOT_FOUND' : 'HTTP_ERROR';
    let retryable = response.status >= 500 || response.status === 429;

    try {
      const payload = (await response.json()) as {
        error?: string;
        code?: string;
        retryable?: boolean;
      };
      if (payload.error) errorMessage = payload.error;
      if (payload.code) errorCode = payload.code;
      if (typeof payload.retryable === 'boolean') retryable = payload.retryable;
    } catch {
      // Non-JSON response
    }

    throw new ChatApiError(errorMessage, errorCode, response.status, retryable);
  }

  let data: {
    imageBase64?: string;
    mimeType?: string;
    caption?: string;
    model?: string;
    provider?: string;
    aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
  };
  try {
    data = (await response.json()) as typeof data;
  } catch {
    throw new ChatApiError(
      'Received an invalid response from the image endpoint. Please try again.',
      'MALFORMED_RESPONSE',
      502,
      true
    );
  }

  if (!data.imageBase64) {
    throw new ChatApiError('No image data returned by image service.', 'NO_IMAGE_RETURNED', 502, true);
  }

  const mimeType = data.mimeType || 'image/png';
  return {
    imageBase64: data.imageBase64,
    mimeType,
    dataUrl: `data:${mimeType};base64,${data.imageBase64}`,
    caption: data.caption,
    model: data.model,
    provider: data.provider,
    aspectRatio: data.aspectRatio ?? aspectRatio,
  };
}
