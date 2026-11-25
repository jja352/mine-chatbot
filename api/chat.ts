import type { IncomingMessage, ServerResponse } from 'node:http';
import { GoogleGenAI, ThinkingLevel, type Content, type Part } from '@google/genai';

const FAST_MODEL_NAME = 'gemini-3.1-flash-lite';
const REASONING_MODEL_NAME = 'gemini-4-hydrogen';

const BASE_SYSTEM_INSTRUCTION = [
  'You are Lumen, an intelligent, versatile, human-like AI assistant.',
  'Language & Tone: Automatically detect and respond naturally in the exact language and script the user uses—including English, Urdu (اردو), Roman Urdu, or mixed code-switching. Be warm, direct, insightful, and conversational without robotic filler or repetitive preambles.',
  'Clarity & Depth: Give crisp, to-the-point answers for simple questions. For complex requests (coding, debugging, business strategy, roadmaps, research, data analysis, writing, or math), provide well-structured, thorough guidance using clean Markdown, syntax-highlighted code blocks, tables, and step-by-step breakdowns.',
  'Proactive Intelligence: When a request has important ambiguities, briefly ask 1–2 focused clarifying questions rather than guessing blindly. End complex answers with a concise, genuinely helpful next step or follow-up suggestion when appropriate.',
  'Attachments & Visuals: Carefully analyze attached images, PDFs, code, and data files. If the user asks for an SVG diagram, chart, or UI wireframe, output clean inline ```svg or ```html code blocks.',
].join('\n\n');

const MAX_HISTORY_TURNS = 10;
const MAX_HISTORY_CHARS = 6000;
const MAX_SINGLE_HISTORY_CHARS = 1500;
const PRIMARY_COOLDOWN_MS = 120_000;
const MAX_REQUEST_BYTES = Math.floor(4.5 * 1024 * 1024);

const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

let cachedAiClient: { apiKey: string; client: GoogleGenAI } | null = null;
let primaryModelCooldownUntil = 0;

type AssistantMode = 'fast' | 'think' | 'search';

interface IncomingHistoryItem {
  role?: string;
  content?: string;
}

interface IncomingAttachment {
  name?: unknown;
  mimeType?: unknown;
  kind?: unknown;
  dataBase64?: unknown;
  textContent?: unknown;
}

interface ChatRequestBody {
  message?: unknown;
  history?: unknown;
  mode?: unknown;
  attachments?: unknown;
  memories?: unknown;
}

interface NormalizedError {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
}

type NodeRequest = IncomingMessage & { body?: unknown };

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

async function readJsonBody(req: NodeRequest): Promise<ChatRequestBody> {
  if (req.body && typeof req.body === 'object') {
    return req.body as ChatRequestBody;
  }
  if (typeof req.body === 'string') {
    return (JSON.parse(req.body) as ChatRequestBody) ?? {};
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    totalBytes += buf.length;
    if (totalBytes > MAX_REQUEST_BYTES) {
      throw new Error('PAYLOAD_TOO_LARGE');
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  return (JSON.parse(raw) as ChatRequestBody) ?? {};
}

function classifyGeminiError(err: unknown): NormalizedError {
  const rawMessage =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'Unexpected error communicating with Gemini API.';

  const statusFromErr =
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as { status: unknown }).status === 'number'
      ? (err as { status: number }).status
      : undefined;

  const lower = rawMessage.toLowerCase();

  if (
    statusFromErr === 401 ||
    statusFromErr === 403 ||
    lower.includes('permission_denied') ||
    lower.includes('api_key_invalid') ||
    lower.includes('api key not valid') ||
    lower.includes('unauthorized')
  ) {
    return {
      status: statusFromErr === 401 ? 401 : 403,
      code: 'API_KEY_INVALID',
      message:
        'Your Gemini API key appears invalid or lacks permission. Please verify GEMINI_API_KEY in your environment variables.',
      retryable: false,
    };
  }

  if (
    statusFromErr === 429 ||
    lower.includes('resource_exhausted') ||
    lower.includes('rate limit') ||
    lower.includes('quota') ||
    lower.includes('429')
  ) {
    return {
      status: 429,
      code: 'RATE_LIMIT',
      message:
        'Gemini API rate limit or free-tier quota reached. Please wait a moment and try again.',
      retryable: true,
    };
  }

  if (statusFromErr === 404 || lower.includes('not_found') || lower.includes('is not found')) {
    return {
      status: 404,
      code: 'MODEL_NOT_FOUND',
      message: 'The configured Gemini model could not be found or is unavailable.',
      retryable: false,
    };
  }

  if (statusFromErr === 400 || lower.includes('invalid_argument')) {
    return {
      status: 400,
      code: 'INVALID_REQUEST',
      message:
        'The request or attached file could not be processed by Gemini. Please check your input and try again.',
      retryable: false,
    };
  }

  if (
    statusFromErr === 408 ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('etimedout') ||
    lower.includes('aborted')
  ) {
    return {
      status: 504,
      code: 'TIMEOUT',
      message: 'Gemini took too long to respond. Please try again.',
      retryable: true,
    };
  }

  if (
    statusFromErr === 503 ||
    statusFromErr === 502 ||
    statusFromErr === 504 ||
    lower.includes('overloaded') ||
    lower.includes('unavailable') ||
    lower.includes('fetch failed') ||
    lower.includes('econnreset')
  ) {
    return {
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Gemini is temporarily busy or unreachable. Please retry in a few seconds.',
      retryable: true,
    };
  }

  return {
    status: statusFromErr && statusFromErr >= 400 && statusFromErr < 600 ? statusFromErr : 500,
    code: 'GEMINI_ERROR',
    message: 'Unable to generate a response right now. Please try again.',
    retryable: true,
  };
}

function buildNormalizedHistory(rawHistory: unknown): Content[] {
  if (!Array.isArray(rawHistory)) {
    return [];
  }

  const recentSlice = rawHistory.slice(-MAX_HISTORY_TURNS) as IncomingHistoryItem[];
  const selectedReversed: { role: 'user' | 'model'; text: string }[] = [];
  let charBudget = MAX_HISTORY_CHARS;

  for (let i = recentSlice.length - 1; i >= 0; i--) {
    const item = recentSlice[i];
    if (!item || typeof item.content !== 'string') continue;
    let text = item.content.trim();
    if (!text) continue;

    if (text.length > MAX_SINGLE_HISTORY_CHARS) {
      text = `${text.slice(0, MAX_SINGLE_HISTORY_CHARS)}…`;
    }

    if (charBudget - text.length < 0 && selectedReversed.length > 0) {
      break;
    }

    const role: 'user' | 'model' =
      item.role === 'assistant' || item.role === 'model' ? 'model' : 'user';
    selectedReversed.push({ role, text });
    charBudget -= text.length;
  }

  const ordered = selectedReversed.reverse();
  const normalized: Content[] = [];

  for (const item of ordered) {
    if (normalized.length === 0 && item.role !== 'user') {
      continue;
    }

    const prev = normalized[normalized.length - 1];
    if (prev && prev.role === item.role && prev.parts?.[0] && 'text' in prev.parts[0]) {
      prev.parts[0].text = `${prev.parts[0].text}\n\n${item.text}`;
    } else {
      normalized.push({ role: item.role, parts: [{ text: item.text }] });
    }
  }

  return normalized;
}

function buildAttachmentParts(rawAttachments: unknown): Part[] {
  if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) {
    return [];
  }

  const parts: Part[] = [];
  const items = rawAttachments.slice(0, 4) as IncomingAttachment[];

  for (const att of items) {
    if (!att || typeof att !== 'object') continue;
    const name =
      typeof att.name === 'string' && att.name.trim()
        ? att.name.trim().slice(0, 120)
        : 'attachment';
    const mimeType = typeof att.mimeType === 'string' ? att.mimeType.trim() : '';
    const kind = att.kind;

    if (kind === 'image' && ALLOWED_IMAGE_MIMES.has(mimeType) && typeof att.dataBase64 === 'string') {
      const cleaned = att.dataBase64.replace(/^data:[^;]+;base64,/, '').trim();
      if (cleaned.length > 0) {
        parts.push({ inlineData: { mimeType, data: cleaned } });
      }
      continue;
    }

    if (kind === 'pdf' && mimeType === 'application/pdf' && typeof att.dataBase64 === 'string') {
      const cleaned = att.dataBase64.replace(/^data:[^;]+;base64,/, '').trim();
      if (cleaned.length > 0) {
        parts.push({ inlineData: { mimeType: 'application/pdf', data: cleaned } });
      }
      continue;
    }

    if (kind === 'text' && typeof att.textContent === 'string') {
      const snippet = att.textContent.slice(0, 60_000).trim();
      if (snippet) {
        parts.push({
          text: `[Attached file: ${name}${mimeType ? ` (${mimeType})` : ''}]\n\`\`\`\n${snippet}\n\`\`\``,
        });
      }
    }
  }

  return parts;
}

function buildSystemInstruction(rawMemories: unknown): string {
  if (!Array.isArray(rawMemories) || rawMemories.length === 0) {
    return BASE_SYSTEM_INSTRUCTION;
  }

  const cleaned = rawMemories
    .filter((m): m is string => typeof m === 'string')
    .map((m) => m.trim().slice(0, 240))
    .filter(Boolean)
    .slice(0, 15);

  if (cleaned.length === 0) {
    return BASE_SYSTEM_INSTRUCTION;
  }

  const memoryBlock = cleaned.map((item) => `- ${item}`).join('\n');
  return `${BASE_SYSTEM_INSTRUCTION}\n\nPersistent User Memory (respect these facts/preferences naturally across replies):\n${memoryBlock}`;
}

function sanitizeHttpUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

export default async function handler(req: NodeRequest, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, {
      error: 'Method not allowed. Use POST.',
      code: 'METHOD_NOT_ALLOWED',
      retryable: false,
    });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === '' || apiKey === 'MY_GEMINI_API_KEY') {
    sendJson(res, 503, {
      error:
        'Gemini API key is not configured. Please set GEMINI_API_KEY in your environment variables.',
      code: 'MISSING_API_KEY',
      retryable: false,
    });
    return;
  }

  let body: ChatRequestBody;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    const isTooLarge = err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE';
    sendJson(res, isTooLarge ? 413 : 400, {
      error: isTooLarge
        ? 'Attached files exceed the 4.5MB request limit. Please use smaller files.'
        : 'Invalid JSON request body.',
      code: isTooLarge ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON',
      retryable: false,
    });
    return;
  }

  const rawMessage = typeof body.message === 'string' ? body.message.trim() : '';
  const attachmentParts = buildAttachmentParts(body.attachments);

  if (!rawMessage && attachmentParts.length === 0) {
    sendJson(res, 400, {
      error: 'Please enter a message or attach a file before sending.',
      code: 'EMPTY_MESSAGE',
      retryable: false,
    });
    return;
  }

  let message = rawMessage || 'Please analyze the attached file(s) and provide a clear summary.';
  if (message.length > 32000) {
    sendJson(res, 400, {
      error: 'Message exceeds the 32,000 character limit.',
      code: 'MESSAGE_TOO_LONG',
      retryable: false,
    });
    return;
  }

  const mode: AssistantMode =
    body.mode === 'think' || body.mode === 'search' ? body.mode : 'fast';

  const history = buildNormalizedHistory(body.history);
  if (history.length > 0 && history[history.length - 1].role === 'user') {
    const last = history.pop();
    const lastText = last?.parts?.[0] && 'text' in last.parts[0] ? last.parts[0].text : '';
    if (lastText) {
      message = `${lastText}\n\n${message}`;
    }
  }

  const userParts: Part[] = [...attachmentParts, { text: message }];
  const contents: Content[] = [...history, { role: 'user', parts: userParts }];
  const systemInstruction = buildSystemInstruction(body.memories);
  const containsUrl = /https?:\/\/[^\s]+/i.test(message);

  const tools: Array<{ googleSearch?: Record<string, never>; urlContext?: Record<string, never> }> = [];
  if (mode === 'search') {
    tools.push({ googleSearch: {} });
  }
  if (containsUrl && mode !== 'think') {
    tools.push({ urlContext: {} });
  }

  const ai = getAiClient(apiKey);
  const attemptAbortControllers = new Set<AbortController>();
  let clientAborted = false;

  res.on('close', () => {
    if (!res.writableEnded) {
      clientAborted = true;
      for (const ac of attemptAbortControllers) {
        ac.abort();
      }
    }
  });

  const inCooldown = Date.now() < primaryModelCooldownUntil;
  let modelAttempts: string[];
  if (mode === 'think') {
    modelAttempts = [REASONING_MODEL_NAME, FAST_MODEL_NAME];
  } else if (inCooldown) {
    modelAttempts = [REASONING_MODEL_NAME];
  } else {
    modelAttempts = [FAST_MODEL_NAME, REASONING_MODEL_NAME];
  }

  interface StreamChunkLike {
    text?: string;
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          thought?: boolean;
        }>;
      };
      groundingMetadata?: {
        groundingChunks?: Array<{
          web?: {
            uri?: string;
            title?: string;
          };
        }>;
      };
    }>;
  }

  let streamIterable: AsyncIterable<StreamChunkLike> | null = null;
  let primaryError: NormalizedError | null = null;

  for (let i = 0; i < modelAttempts.length; i++) {
    if (clientAborted) return;

    const candidateModel = modelAttempts[i];
    const isFast = candidateModel === FAST_MODEL_NAME;
    const isFirstAttempt = i === 0;
    const timeoutMs =
      mode === 'think' && candidateModel === REASONING_MODEL_NAME
        ? 18000
        : isFirstAttempt && isFast
          ? 7000
          : isFast
            ? 9000
            : 12000;

    const attemptController = new AbortController();
    attemptAbortControllers.add(attemptController);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      attemptController.abort();
    }, timeoutMs);

    try {
      const thinkingConfig =
        candidateModel === REASONING_MODEL_NAME
          ? mode === 'think'
            ? { thinkingLevel: ThinkingLevel.MEDIUM, includeThoughts: true }
            : { thinkingLevel: ThinkingLevel.LOW }
          : undefined;

      const effectiveSystemInstruction =
        mode === 'think' && candidateModel === FAST_MODEL_NAME
          ? `${systemInstruction}\n\nReason carefully step-by-step to ensure high accuracy and clear structure.`
          : systemInstruction;

      streamIterable = (await ai.models.generateContentStream({
        model: candidateModel,
        contents,
        config: {
          systemInstruction: effectiveSystemInstruction,
          abortSignal: attemptController.signal,
          ...(thinkingConfig ? { thinkingConfig } : {}),
          ...(tools.length > 0 ? { tools } : {}),
        },
      })) as AsyncIterable<StreamChunkLike>;

      clearTimeout(timer);
      if (isFast && tools.length === 0) {
        primaryModelCooldownUntil = 0;
      }
      break;
    } catch (err) {
      clearTimeout(timer);
      attemptAbortControllers.delete(attemptController);

      const effectiveErr = timedOut
        ? new Error(`Gemini ${candidateModel} timed out after ${timeoutMs}ms`)
        : err;
      const classified = classifyGeminiError(effectiveErr);
      if (isFirstAttempt) {
        primaryError = classified;
      }
      if (tools.length === 0 && isFast && classified.code === 'MODEL_NOT_FOUND') {
        primaryModelCooldownUntil = Date.now() + PRIMARY_COOLDOWN_MS;
      }
      const isLastAttempt = i === modelAttempts.length - 1;
      const canAdvance =
        !isLastAttempt && (classified.retryable || classified.code === 'MODEL_NOT_FOUND');

      if (!canAdvance || clientAborted) {
        const reportedError =
          !isFirstAttempt &&
          primaryError &&
          classified.code === 'RATE_LIMIT' &&
          (primaryError.code === 'SERVICE_UNAVAILABLE' || primaryError.code === 'TIMEOUT')
            ? primaryError
            : classified;

        console.error('[api/chat] Failed to start Gemini stream:', reportedError.code, effectiveErr);
        sendJson(res, reportedError.status, {
          error: reportedError.message,
          code: reportedError.code,
          retryable: reportedError.retryable,
        });
        return;
      }
    }
  }

  if (!streamIterable) {
    sendJson(res, 500, {
      error: 'Could not initialize Gemini response stream.',
      code: 'STREAM_INIT_FAILED',
      retryable: true,
    });
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  (res as ServerResponse & { flushHeaders?: () => void }).flushHeaders?.();

  try {
    let emittedAnyText = false;
    const sourcesMap = new Map<string, string>();

    for await (const chunk of streamIterable) {
      if (clientAborted) {
        break;
      }

      const groundingChunks = chunk.candidates?.[0]?.groundingMetadata?.groundingChunks;
      if (Array.isArray(groundingChunks)) {
        for (const gc of groundingChunks) {
          const validUrl = sanitizeHttpUrl(gc.web?.uri);
          if (validUrl && !sourcesMap.has(validUrl)) {
            const title =
              typeof gc.web?.title === 'string' && gc.web.title.trim()
                ? gc.web.title.trim()
                : new URL(validUrl).hostname;
            sourcesMap.set(validUrl, title);
          }
        }
      }

      const parts = chunk.candidates?.[0]?.content?.parts;
      if (Array.isArray(parts) && parts.length > 0) {
        for (const part of parts) {
          if (typeof part.text !== 'string' || part.text.length === 0) continue;
          if (part.thought) {
            res.write(`data: ${JSON.stringify({ thought: part.text })}\n\n`);
          } else {
            emittedAnyText = true;
            res.write(`data: ${JSON.stringify({ text: part.text })}\n\n`);
          }
        }
      } else if (typeof chunk.text === 'string' && chunk.text.length > 0) {
        emittedAnyText = true;
        res.write(`data: ${JSON.stringify({ text: chunk.text })}\n\n`);
      }
    }

    if (!clientAborted) {
      if (sourcesMap.size > 0) {
        const sources = Array.from(sourcesMap.entries())
          .slice(0, 8)
          .map(([url, title]) => ({ url, title }));
        res.write(`data: ${JSON.stringify({ sources })}\n\n`);
      }

      if (!emittedAnyText) {
        res.write(
          `data: ${JSON.stringify({
            error: 'Gemini returned an empty response. Please try rephrasing your prompt.',
            code: 'EMPTY_RESPONSE',
            retryable: true,
          })}\n\n`
        );
      } else {
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      }
      res.end();
    }
  } catch (err) {
    const classified = classifyGeminiError(err);
    console.error('[api/chat] Stream error:', classified.code, err);
    if (!clientAborted) {
      res.write(
        `data: ${JSON.stringify({
          error: classified.message,
          code: classified.code,
          retryable: classified.retryable,
        })}\n\n`
      );
      res.end();
    }
  }
}
