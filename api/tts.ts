import type { IncomingMessage, ServerResponse } from 'node:http';
import { GoogleGenAI } from '@google/genai';

const TTS_MODEL_NAME = 'gemini-3.8-flash-lite-tts';
const ALLOWED_VOICES = new Set(['Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr']);

let cachedAiClient: { apiKey: string; client: GoogleGenAI } | null = null;

type NodeRequest = IncomingMessage & { body?: unknown };

interface TtsRequestBody {
  text?: unknown;
  voice?: unknown;
}

function getAiClient(apiKey: string): GoogleGenAI {
  if (cachedAiClient && cachedAiClient.apiKey === apiKey) {
    return cachedAiClient.client;
  }
  const client = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
      retryOptions: {
        attempts: 1,
      },
    },
  });
  cachedAiClient = { apiKey, client };
  return client;
}

function sendJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: NodeRequest): Promise<TtsRequestBody> {
  if (req.body && typeof req.body === 'object') {
    return req.body as TtsRequestBody;
  }
  if (typeof req.body === 'string') {
    return (JSON.parse(req.body) as TtsRequestBody) ?? {};
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const maxBytes = 64 * 1024;

  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    totalBytes += buf.length;
    if (totalBytes > maxBytes) {
      throw new Error('PAYLOAD_TOO_LARGE');
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  return (JSON.parse(raw) as TtsRequestBody) ?? {};
}

function cleanTextForSpeech(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, ' Code snippet omitted. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1400);
}

export default async function handler(req: NodeRequest, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed. Use POST.', code: 'METHOD_NOT_ALLOWED' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === '' || apiKey === 'MY_GEMINI_API_KEY') {
    sendJson(res, 503, { error: 'Gemini API key is not configured.', code: 'MISSING_API_KEY' });
    return;
  }

  let body: TtsRequestBody;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON request body.', code: 'INVALID_JSON' });
    return;
  }

  if (typeof body.text !== 'string') {
    sendJson(res, 400, { error: 'Text must be a non-empty string.', code: 'INVALID_INPUT' });
    return;
  }

  const cleanedText = cleanTextForSpeech(body.text);
  if (!cleanedText) {
    sendJson(res, 400, { error: 'No speakable text provided.', code: 'EMPTY_TEXT' });
    return;
  }

  const voiceName =
    typeof body.voice === 'string' && ALLOWED_VOICES.has(body.voice) ? body.voice : 'Kore';

  try {
    const ai = getAiClient(apiKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    const response = await ai.models
      .generateContent({
        model: TTS_MODEL_NAME,
        contents: [
          {
            role: 'user',
            parts: [{ text: cleanedText }],
          },
        ],
        config: {
          abortSignal: controller.signal,
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      })
      .finally(() => clearTimeout(timer));

    const audioPart = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    const base64Audio = audioPart?.inlineData?.data;
    const mimeType = audioPart?.inlineData?.mimeType ?? 'audio/wav';

    if (!base64Audio) {
      sendJson(res, 502, { error: 'No audio generated.', code: 'EMPTY_AUDIO' });
      return;
    }

    sendJson(res, 200, {
      audioBase64: base64Audio,
      mimeType,
    });
  } catch (err) {
    console.error('[api/tts] TTS generation failed:', err);
    sendJson(res, 503, {
      error: 'Unable to generate speech right now.',
      code: 'TTS_UNAVAILABLE',
    });
  }
}
