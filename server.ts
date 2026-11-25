import 'dotenv/config';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import express, { type Request, type Response } from 'express';
import chatHandler from './api/chat.ts';
import healthHandler from './api/health.ts';
import imageHandler from './api/image.ts';
import ttsHandler from './api/tts.ts';

// Also load .env.local if present without overriding injected env vars
const envLocalPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envLocalPath)) {
  dotenv.config({ path: envLocalPath, override: false });
}

const PORT = Number(process.env.PORT) || 3000;

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.all('/api/health', (req: Request, res: Response) => {
    healthHandler(req, res);
  });

  app.all('/api/chat', async (req: Request, res: Response) => {
    await chatHandler(req, res);
  });

  app.all('/api/image', async (req: Request, res: Response) => {
    await imageHandler(req, res);
  });

  app.all('/api/tts', async (req: Request, res: Response) => {
    await ttsHandler(req, res);
  });

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({
      error: 'API endpoint not found.',
      code: 'API_NOT_FOUND',
      retryable: false,
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Lumen Chat server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
