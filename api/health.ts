import type { IncomingMessage, ServerResponse } from 'node:http';

function resolveHealthImageConfig(): { provider: string; model: string } {
  const configured = (process.env.IMAGE_PROVIDER || 'auto').trim().toLowerCase();
  const hasHf = Boolean((process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN)?.trim());
  const hasOpenAi = Boolean(process.env.OPENAI_API_KEY?.trim());
  const hasPollinations = Boolean(process.env.POLLINATIONS_API_KEY?.trim());

  if (configured === 'huggingface' || (configured === 'auto' && hasHf)) {
    return {
      provider: 'huggingface',
      model: process.env.HUGGINGFACE_IMAGE_MODEL || 'black-forest-labs/FLUX.1-schnell',
    };
  }
  if (configured === 'openai' || (configured === 'auto' && hasOpenAi)) {
    return {
      provider: 'openai',
      model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
    };
  }
  if (configured === 'pollinations' || (configured === 'auto' && hasPollinations)) {
    return {
      provider: 'pollinations',
      model: process.env.POLLINATIONS_IMAGE_MODEL || 'flux',
    };
  }
  if (configured === 'gemini') {
    return {
      provider: 'gemini',
      model: process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-lite-image',
    };
  }
  return {
    provider: 'auto (gemini / pollinations-flux)',
    model: process.env.POLLINATIONS_IMAGE_MODEL || 'flux',
  };
}

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' }));
    return;
  }

  const hasKey = Boolean(
    process.env.GEMINI_API_KEY &&
      process.env.GEMINI_API_KEY.trim() !== '' &&
      process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
  );

  const imageConfig = resolveHealthImageConfig();

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(
    JSON.stringify({
      ok: true,
      model: 'gemini-3.1-flash-lite',
      imageProvider: imageConfig.provider,
      imageModel: imageConfig.model,
      configured: hasKey,
      capabilities: {
        fast: true,
        think: true,
        search: true,
        image: true,
        visionAndPdf: true,
        tts: true,
      },
    })
  );
}
