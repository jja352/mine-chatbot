import type { IncomingMessage, ServerResponse } from 'node:http';
import { GoogleGenAI, type Part } from '@google/genai';

type ImageProvider = 'gemini' | 'huggingface' | 'openai' | 'pollinations';
type ImageProviderSetting = ImageProvider | 'auto';

const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-lite-image';
const DEFAULT_HF_IMAGE_MODEL = 'black-forest-labs/FLUX.1-schnell';
const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-1';
const DEFAULT_POLLINATIONS_MODEL = 'flux';

const ALLOWED_ASPECT_RATIOS = new Set(['1:1', '3:4', '4:3', '9:16', '16:9']);
const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_REQUEST_BYTES = Math.floor(4.5 * 1024 * 1024);
const GEMINI_BILLING_CACHE_MS = 10 * 60 * 1000;

let cachedAiClient: { apiKey: string; client: GoogleGenAI } | null = null;
let geminiBillingRequiredUntil = 0;

type NodeRequest = IncomingMessage & { body?: unknown };

interface ImageRequestBody {
  prompt?: unknown;
  aspectRatio?: unknown;
  sourceImage?: {
    dataBase64?: unknown;
    mimeType?: unknown;
  };
}

interface ImageGenerationOutput {
  imageBase64: string;
  mimeType: string;
  caption?: string;
  model: string;
  provider: ImageProvider;
  aspectRatio: string;
}

class NormalizedImageError extends Error {
  status: number;
  code: string;
  retryable: boolean;

  constructor(status: number, code: string, message: string, retryable = true) {
    super(message);
    this.name = 'NormalizedImageError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
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
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: NodeRequest): Promise<ImageRequestBody> {
  if (req.body && typeof req.body === 'object') {
    return req.body as ImageRequestBody;
  }
  if (typeof req.body === 'string') {
    return (JSON.parse(req.body) as ImageRequestBody) ?? {};
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
  return (JSON.parse(raw) as ImageRequestBody) ?? {};
}

function hasValidGeminiKey(): string | null {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || key === 'MY_GEMINI_API_KEY') return null;
  return key;
}

function getHuggingFaceKey(): string | null {
  const key = (process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN)?.trim();
  if (!key || key === 'MY_HUGGINGFACE_API_KEY') return null;
  return key;
}

function getOpenAiKey(): string | null {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key || key === 'MY_OPENAI_API_KEY') return null;
  return key;
}

function getPollinationsKey(): string | null {
  const key = process.env.POLLINATIONS_API_KEY?.trim();
  if (!key || key === 'MY_POLLINATIONS_API_KEY') return null;
  return key;
}

function getConfiguredProviderSetting(): ImageProviderSetting {
  const raw = (process.env.IMAGE_PROVIDER || 'auto').trim().toLowerCase();
  if (
    raw === 'gemini' ||
    raw === 'huggingface' ||
    raw === 'openai' ||
    raw === 'pollinations'
  ) {
    return raw;
  }
  return 'auto';
}

function aspectRatioToDimensions(aspectRatio: string): { width: number; height: number } {
  switch (aspectRatio) {
    case '16:9':
      return { width: 1024, height: 576 };
    case '9:16':
      return { width: 576, height: 1024 };
    case '4:3':
      return { width: 1024, height: 768 };
    case '3:4':
      return { width: 768, height: 1024 };
    default:
      return { width: 1024, height: 1024 };
  }
}

function detectImageMimeFromBuffer(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  // GIF: GIF8
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return 'image/gif';
  }
  // WEBP: RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

function classifyGeminiError(err: unknown, modelName: string): NormalizedImageError {
  if (err instanceof NormalizedImageError) return err;

  const rawMessage =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'Unexpected error generating image.';

  const statusFromErr =
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as { status: unknown }).status === 'number'
      ? (err as { status: number }).status
      : undefined;

  const lower = rawMessage.toLowerCase();

  if (
    lower.includes('free_tier') ||
    lower.includes('limit: 0') ||
    lower.includes('"quotavalue":"0"') ||
    lower.includes('billing') ||
    lower.includes('paid tier') ||
    lower.includes('paid api key')
  ) {
    return new NormalizedImageError(
      402,
      'PAID_KEY_REQUIRED',
      `Image generation (${modelName}) requires a billing-enabled Gemini API key and is not included in the free-tier quota.`,
      false
    );
  }

  if (
    statusFromErr === 401 ||
    statusFromErr === 403 ||
    lower.includes('permission_denied') ||
    lower.includes('api_key_invalid') ||
    lower.includes('api key not valid') ||
    lower.includes('unauthorized')
  ) {
    return new NormalizedImageError(
      statusFromErr === 401 ? 401 : 403,
      'API_KEY_INVALID',
      'Your Gemini API key appears invalid or lacks permission for image generation. Please check GEMINI_API_KEY.',
      false
    );
  }

  if (
    statusFromErr === 429 ||
    lower.includes('resource_exhausted') ||
    lower.includes('rate limit') ||
    lower.includes('quota')
  ) {
    return new NormalizedImageError(
      429,
      'RATE_LIMIT',
      'Gemini image quota or rate limit was reached. Please wait a moment and try again.',
      true
    );
  }

  if (statusFromErr === 404 || lower.includes('not_found') || lower.includes('is not found')) {
    return new NormalizedImageError(
      404,
      'MODEL_NOT_FOUND',
      `Configured Gemini image model (${modelName}) is unavailable or unsupported.`,
      false
    );
  }

  if (statusFromErr === 400 || lower.includes('invalid_argument')) {
    return new NormalizedImageError(
      400,
      'INVALID_REQUEST',
      'The image prompt or reference image could not be processed. Please adjust your prompt and try again.',
      false
    );
  }

  if (
    statusFromErr === 408 ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('aborted')
  ) {
    return new NormalizedImageError(
      504,
      'TIMEOUT',
      'Image generation timed out. Please try again.',
      true
    );
  }

  if (
    statusFromErr === 503 ||
    statusFromErr === 502 ||
    statusFromErr === 504 ||
    lower.includes('overloaded') ||
    lower.includes('unavailable') ||
    lower.includes('fetch failed')
  ) {
    return new NormalizedImageError(
      503,
      'SERVICE_UNAVAILABLE',
      'Image generation service is temporarily busy. Please retry in a few seconds.',
      true
    );
  }

  return new NormalizedImageError(
    statusFromErr && statusFromErr >= 400 && statusFromErr < 600 ? statusFromErr : 500,
    'IMAGE_GENERATION_FAILED',
    'Unable to generate image right now. Please try again.',
    true
  );
}

async function generateWithGemini({
  prompt,
  aspectRatio,
  sourceImage,
  signal,
}: {
  prompt: string;
  aspectRatio: string;
  sourceImage?: { dataBase64: string; mimeType: string };
  signal: AbortSignal;
}): Promise<ImageGenerationOutput> {
  const apiKey = hasValidGeminiKey();
  if (!apiKey) {
    throw new NormalizedImageError(
      503,
      'MISSING_API_KEY',
      'GEMINI_API_KEY is not configured in server environment variables.',
      false
    );
  }

  const modelName = (process.env.GEMINI_IMAGE_MODEL || DEFAULT_GEMINI_IMAGE_MODEL).trim();
  const parts: Part[] = [];
  if (sourceImage) {
    parts.push({
      inlineData: {
        mimeType: sourceImage.mimeType,
        data: sourceImage.dataBase64,
      },
    });
  }
  parts.push({ text: prompt });

  const ai = getAiClient(apiKey);
  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: { parts },
      config: {
        abortSignal: signal,
        imageConfig: { aspectRatio },
      },
    });

    const candidate = response.candidates?.[0];
    const finishReason = candidate?.finishReason ? String(candidate.finishReason) : '';
    if (
      finishReason === 'SAFETY' ||
      finishReason === 'IMAGE_SAFETY' ||
      finishReason === 'PROHIBITED_CONTENT'
    ) {
      throw new NormalizedImageError(
        400,
        'SAFETY_BLOCK',
        'The image request was blocked by safety filters. Please rephrase your prompt.',
        false
      );
    }

    let imageBase64 = '';
    let imageMime = 'image/png';
    let captionText = '';

    for (const part of candidate?.content?.parts ?? []) {
      if (part.inlineData?.data && !imageBase64) {
        imageBase64 = part.inlineData.data;
        imageMime = part.inlineData.mimeType ?? 'image/png';
      } else if (typeof part.text === 'string' && part.text.trim()) {
        captionText += (captionText ? '\n' : '') + part.text.trim();
      }
    }

    if (!imageBase64) {
      throw new NormalizedImageError(
        502,
        'NO_IMAGE_RETURNED',
        captionText || 'Gemini did not return an image for this prompt. Please describe the scene clearly.',
        true
      );
    }

    return {
      imageBase64,
      mimeType: imageMime,
      caption: captionText || undefined,
      model: modelName,
      provider: 'gemini',
      aspectRatio,
    };
  } catch (err) {
    const classified = classifyGeminiError(err, modelName);
    if (classified.code === 'PAID_KEY_REQUIRED') {
      geminiBillingRequiredUntil = Date.now() + GEMINI_BILLING_CACHE_MS;
    }
    throw classified;
  }
}

async function generateWithHuggingFace({
  prompt,
  aspectRatio,
  signal,
}: {
  prompt: string;
  aspectRatio: string;
  signal: AbortSignal;
}): Promise<ImageGenerationOutput> {
  const hfKey = getHuggingFaceKey();
  if (!hfKey) {
    throw new NormalizedImageError(
      503,
      'MISSING_API_KEY',
      'HUGGINGFACE_API_KEY is not configured in server environment variables.',
      false
    );
  }

  const modelName = (process.env.HUGGINGFACE_IMAGE_MODEL || DEFAULT_HF_IMAGE_MODEL).trim();
  const { width, height } = aspectRatioToDimensions(aspectRatio);

  let response: Response;
  try {
    response = await fetch(
      `https://router.huggingface.co/hf-inference/models/${encodeURIComponent(modelName).replace(/%2F/g, '/')}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${hfKey}`,
          'Content-Type': 'application/json',
          Accept: 'image/png,image/jpeg',
        },
        body: JSON.stringify({
          inputs: prompt,
          parameters: { width, height },
        }),
        signal,
      }
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new NormalizedImageError(504, 'TIMEOUT', 'Image generation timed out. Please try again.', true);
    }
    throw new NormalizedImageError(
      503,
      'SERVICE_UNAVAILABLE',
      'Unable to reach the Hugging Face image service right now. Please try again.',
      true
    );
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new NormalizedImageError(
        response.status,
        'API_KEY_INVALID',
        'Invalid or unauthorized HUGGINGFACE_API_KEY. Please verify your token.',
        false
      );
    }
    if (response.status === 404) {
      throw new NormalizedImageError(
        404,
        'MODEL_NOT_FOUND',
        `Configured Hugging Face image model (${modelName}) could not be found.`,
        false
      );
    }
    if (response.status === 429) {
      throw new NormalizedImageError(
        429,
        'RATE_LIMIT',
        'Hugging Face free inference rate limit reached. Please wait a moment and try again.',
        true
      );
    }
    if (response.status === 402) {
      throw new NormalizedImageError(
        402,
        'PAID_KEY_REQUIRED',
        'Hugging Face monthly free inference credits were exhausted for this token.',
        false
      );
    }
    throw new NormalizedImageError(
      response.status >= 500 ? 503 : 502,
      'IMAGE_GENERATION_FAILED',
      'Hugging Face could not generate this image right now. Please try again.',
      true
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const detectedMime = detectImageMimeFromBuffer(buffer);
  if (!detectedMime || buffer.length < 512) {
    throw new NormalizedImageError(
      502,
      'MALFORMED_RESPONSE',
      'Image provider returned an invalid or empty image payload. Please retry.',
      true
    );
  }

  return {
    imageBase64: buffer.toString('base64'),
    mimeType: detectedMime,
    model: modelName,
    provider: 'huggingface',
    aspectRatio,
  };
}

async function generateWithOpenAi({
  prompt,
  aspectRatio,
  signal,
}: {
  prompt: string;
  aspectRatio: string;
  signal: AbortSignal;
}): Promise<ImageGenerationOutput> {
  const apiKey = getOpenAiKey();
  if (!apiKey) {
    throw new NormalizedImageError(
      503,
      'MISSING_API_KEY',
      'OPENAI_API_KEY is not configured in server environment variables.',
      false
    );
  }

  const baseUrl = (process.env.OPENAI_IMAGE_BASE_URL || 'https://api.openai.com/v1').replace(
    /\/+$/,
    ''
  );
  const modelName = (process.env.OPENAI_IMAGE_MODEL || DEFAULT_OPENAI_IMAGE_MODEL).trim();
  const size =
    aspectRatio === '16:9' || aspectRatio === '4:3'
      ? '1536x1024'
      : aspectRatio === '9:16' || aspectRatio === '3:4'
        ? '1024x1536'
        : '1024x1024';

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelName,
        prompt,
        size,
        n: 1,
      }),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new NormalizedImageError(504, 'TIMEOUT', 'Image generation timed out. Please try again.', true);
    }
    throw new NormalizedImageError(
      503,
      'SERVICE_UNAVAILABLE',
      'Unable to reach the configured OpenAI-compatible image service.',
      true
    );
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new NormalizedImageError(
        response.status,
        'API_KEY_INVALID',
        'Invalid or unauthorized OPENAI_API_KEY. Please check your configuration.',
        false
      );
    }
    if (response.status === 429) {
      throw new NormalizedImageError(
        429,
        'RATE_LIMIT',
        'OpenAI image quota or rate limit exceeded. Please check billing or retry shortly.',
        true
      );
    }
    if (response.status === 404) {
      throw new NormalizedImageError(
        404,
        'MODEL_NOT_FOUND',
        `Configured image model (${modelName}) was not found.`,
        false
      );
    }
    throw new NormalizedImageError(
      response.status >= 500 ? 503 : 502,
      'IMAGE_GENERATION_FAILED',
      'The OpenAI-compatible image service returned an error. Please try again.',
      true
    );
  }

  let data: { data?: Array<{ b64_json?: string; url?: string }> };
  try {
    data = (await response.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
  } catch {
    throw new NormalizedImageError(
      502,
      'MALFORMED_RESPONSE',
      'Received malformed JSON from the image service.',
      true
    );
  }

  const first = data?.data?.[0];
  if (first?.b64_json) {
    const buf = Buffer.from(first.b64_json, 'base64');
    const detectedMime = detectImageMimeFromBuffer(buf) ?? 'image/png';
    return {
      imageBase64: first.b64_json,
      mimeType: detectedMime,
      model: modelName,
      provider: 'openai',
      aspectRatio,
    };
  }

  if (first?.url) {
    const parsed = new URL(first.url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new NormalizedImageError(502, 'MALFORMED_RESPONSE', 'Invalid image URL returned.', true);
    }
    const imgRes = await fetch(parsed.toString(), { signal });
    if (!imgRes.ok) {
      throw new NormalizedImageError(502, 'IMAGE_GENERATION_FAILED', 'Failed to download generated image.', true);
    }
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const detectedMime = detectImageMimeFromBuffer(buf);
    if (!detectedMime || buf.length < 512) {
      throw new NormalizedImageError(502, 'MALFORMED_RESPONSE', 'Downloaded image payload was invalid.', true);
    }
    return {
      imageBase64: buf.toString('base64'),
      mimeType: detectedMime,
      model: modelName,
      provider: 'openai',
      aspectRatio,
    };
  }

  throw new NormalizedImageError(
    502,
    'NO_IMAGE_RETURNED',
    'Image provider did not return any image data.',
    true
  );
}

async function generateWithPollinations({
  prompt,
  aspectRatio,
  signal,
}: {
  prompt: string;
  aspectRatio: string;
  signal: AbortSignal;
}): Promise<ImageGenerationOutput> {
  const modelName = (process.env.POLLINATIONS_IMAGE_MODEL || DEFAULT_POLLINATIONS_MODEL).trim();
  const apiKey = getPollinationsKey();
  const { width, height } = aspectRatioToDimensions(aspectRatio);
  const seed = Math.floor(Math.random() * 1_000_000_000);

  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    model: modelName,
    nologo: 'true',
    seed: String(seed),
  });

  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
  const headers: Record<string, string> = {
    Accept: 'image/jpeg,image/png,image/webp',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', headers, signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new NormalizedImageError(
        504,
        'TIMEOUT',
        'Image generation timed out. Please try again.',
        true
      );
    }
    throw new NormalizedImageError(
      503,
      'SERVICE_UNAVAILABLE',
      'Unable to reach the free image-generation service right now. Please try again.',
      true
    );
  }

  if (!response.ok) {
    let errorText = '';
    try {
      errorText = await response.text();
    } catch {
      // Ignore body read failures
    }
    const lower = errorText.toLowerCase();

    if (response.status === 401 || response.status === 403) {
      throw new NormalizedImageError(
        response.status,
        'API_KEY_INVALID',
        'Image provider rejected the API key. Check POLLINATIONS_API_KEY or switch IMAGE_PROVIDER.',
        false
      );
    }

    if (response.status === 402 || response.status === 429 || lower.includes('free_limit')) {
      throw new NormalizedImageError(
        429,
        'RATE_LIMIT',
        apiKey
          ? 'Pollinations quota or rate limit reached. Please wait a moment and retry.'
          : 'Free image generation rate limit reached (about 1 image every 45 seconds without a provider key). Wait a moment and click Retry, or configure HUGGINGFACE_API_KEY / POLLINATIONS_API_KEY or Gemini billing.',
        true
      );
    }

    if (response.status === 404) {
      throw new NormalizedImageError(
        404,
        'MODEL_NOT_FOUND',
        `Configured Pollinations model (${modelName}) is unavailable.`,
        false
      );
    }

    throw new NormalizedImageError(
      response.status >= 500 ? 503 : 502,
      'SERVICE_UNAVAILABLE',
      'The image-generation service is temporarily busy. Please try again in a few seconds.',
      true
    );
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const buffer = Buffer.from(await response.arrayBuffer());
  const detectedMime = detectImageMimeFromBuffer(buffer);

  if (!contentType.startsWith('image/') || !detectedMime || buffer.length < 512) {
    throw new NormalizedImageError(
      502,
      'MALFORMED_RESPONSE',
      'The image service returned an unexpected response instead of a valid image. Please retry.',
      true
    );
  }

  return {
    imageBase64: buffer.toString('base64'),
    mimeType: detectedMime,
    model: modelName,
    provider: 'pollinations',
    aspectRatio,
  };
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

  let body: ImageRequestBody;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    const isTooLarge = err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE';
    sendJson(res, isTooLarge ? 413 : 400, {
      error: isTooLarge ? 'Reference image exceeds 4.5MB limit.' : 'Invalid JSON request body.',
      code: isTooLarge ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON',
      retryable: false,
    });
    return;
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    sendJson(res, 400, {
      error: 'Please enter an image prompt.',
      code: 'EMPTY_PROMPT',
      retryable: false,
    });
    return;
  }

  if (prompt.length > 4000) {
    sendJson(res, 400, {
      error: 'Image prompt exceeds 4,000 characters.',
      code: 'PROMPT_TOO_LONG',
      retryable: false,
    });
    return;
  }

  const aspectRatio =
    typeof body.aspectRatio === 'string' && ALLOWED_ASPECT_RATIOS.has(body.aspectRatio)
      ? body.aspectRatio
      : '1:1';

  let sourceImage: { dataBase64: string; mimeType: string } | undefined;
  if (
    body.sourceImage &&
    typeof body.sourceImage === 'object' &&
    typeof body.sourceImage.dataBase64 === 'string' &&
    typeof body.sourceImage.mimeType === 'string' &&
    ALLOWED_IMAGE_MIMES.has(body.sourceImage.mimeType.trim())
  ) {
    const cleaned = body.sourceImage.dataBase64.replace(/^data:[^;]+;base64,/, '').trim();
    if (cleaned) {
      sourceImage = {
        dataBase64: cleaned,
        mimeType: body.sourceImage.mimeType.trim(),
      };
    }
  }

  const controller = new AbortController();
  let clientAborted = false;

  res.on('close', () => {
    if (!res.writableEnded) {
      clientAborted = true;
      controller.abort();
    }
  });

  const timer = setTimeout(() => controller.abort(), 28000);
  const configuredProvider = getConfiguredProviderSetting();

  try {
    let result: ImageGenerationOutput;

    if (configuredProvider === 'gemini') {
      result = await generateWithGemini({ prompt, aspectRatio, sourceImage, signal: controller.signal });
    } else if (configuredProvider === 'huggingface') {
      if (sourceImage) {
        throw new NormalizedImageError(
          400,
          'EDIT_NOT_SUPPORTED',
          'Reference-image editing is not supported with the Hugging Face text-to-image provider. Start a fresh image prompt or switch IMAGE_PROVIDER=gemini with billing enabled.',
          false
        );
      }
      result = await generateWithHuggingFace({ prompt, aspectRatio, signal: controller.signal });
    } else if (configuredProvider === 'openai') {
      result = await generateWithOpenAi({ prompt, aspectRatio, signal: controller.signal });
    } else if (configuredProvider === 'pollinations') {
      if (sourceImage) {
        throw new NormalizedImageError(
          400,
          'EDIT_NOT_SUPPORTED',
          'Reference-image editing requires a billing-enabled Gemini API key. To generate a new image instead, send a fresh image prompt.',
          false
        );
      }
      result = await generateWithPollinations({ prompt, aspectRatio, signal: controller.signal });
    } else {
      // IMAGE_PROVIDER === 'auto'
      if (sourceImage) {
        if (hasValidGeminiKey()) {
          result = await generateWithGemini({
            prompt,
            aspectRatio,
            sourceImage,
            signal: controller.signal,
          });
        } else if (getOpenAiKey()) {
          result = await generateWithOpenAi({ prompt, aspectRatio, signal: controller.signal });
        } else {
          throw new NormalizedImageError(
            402,
            'PAID_KEY_REQUIRED',
            'Image editing with a reference image requires a billing-enabled Gemini API key.',
            false
          );
        }
      } else if (getHuggingFaceKey()) {
        result = await generateWithHuggingFace({ prompt, aspectRatio, signal: controller.signal });
      } else if (getOpenAiKey()) {
        result = await generateWithOpenAi({ prompt, aspectRatio, signal: controller.signal });
      } else if (getPollinationsKey()) {
        result = await generateWithPollinations({ prompt, aspectRatio, signal: controller.signal });
      } else if (
        hasValidGeminiKey() &&
        Date.now() >= geminiBillingRequiredUntil
      ) {
        try {
          result = await generateWithGemini({ prompt, aspectRatio, signal: controller.signal });
        } catch (geminiErr) {
          const classified = classifyGeminiError(
            geminiErr,
            process.env.GEMINI_IMAGE_MODEL || DEFAULT_GEMINI_IMAGE_MODEL
          );
          if (
            classified.code === 'PAID_KEY_REQUIRED' ||
            classified.code === 'MODEL_NOT_FOUND'
          ) {
            // Free-tier Gemini keys cannot invoke Gemini image models; fall back to free Pollinations FLUX
            result = await generateWithPollinations({
              prompt,
              aspectRatio,
              signal: controller.signal,
            });
          } else {
            throw classified;
          }
        }
      } else {
        result = await generateWithPollinations({ prompt, aspectRatio, signal: controller.signal });
      }
    }

    clearTimeout(timer);
    if (clientAborted) return;

    sendJson(res, 200, {
      imageBase64: result.imageBase64,
      mimeType: result.mimeType,
      caption: result.caption,
      model: result.model,
      provider: result.provider,
      aspectRatio: result.aspectRatio,
    });
  } catch (err) {
    clearTimeout(timer);
    if (clientAborted) return;

    const normalized =
      err instanceof NormalizedImageError
        ? err
        : classifyGeminiError(err, process.env.GEMINI_IMAGE_MODEL || DEFAULT_GEMINI_IMAGE_MODEL);

    console.error('[api/image] Image generation failed:', normalized.code, normalized.message);
    sendJson(res, normalized.status, {
      error: normalized.message,
      code: normalized.code,
      retryable: normalized.retryable,
    });
  }
}
