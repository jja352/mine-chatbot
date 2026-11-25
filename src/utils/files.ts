import type { AttachmentItem } from '../types/chat';
import { createId } from './storage';

const MAX_PDF_BYTES = 2.5 * 1024 * 1024;
const MAX_IMAGE_RAW_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 1.5 * 1024 * 1024;
const MAX_TEXT_CHARS = 60_000;

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'xml',
  'yaml',
  'yml',
  'html',
  'htm',
  'css',
  'scss',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'py',
  'java',
  'c',
  'cpp',
  'h',
  'cs',
  'go',
  'rs',
  'rb',
  'php',
  'sql',
  'sh',
  'bash',
  'env',
  'log',
  'svg',
]);

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Could not read file.'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}

function compressImage(
  dataUrl: string,
  mimeType: string,
  maxDimension: number,
  quality: number
): Promise<{ base64: string; outputMime: string; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDimension || height > maxDimension) {
        const scale = Math.min(maxDimension / width, maxDimension / height);
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas unavailable for image processing.'));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);

      const outputMime =
        mimeType === 'image/png' && width * height <= 800 * 800 ? 'image/png' : 'image/jpeg';
      const compressedUrl = canvas.toDataURL(outputMime, quality);
      const base64 = compressedUrl.split(',')[1] ?? '';
      resolve({ base64, outputMime, dataUrl: compressedUrl });
    };
    img.onerror = () => reject(new Error('Could not decode image file.'));
    img.src = dataUrl;
  });
}

export async function processSelectedFile(file: File): Promise<AttachmentItem> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';

  if (file.type.startsWith('image/')) {
    if (file.size > MAX_IMAGE_RAW_BYTES) {
      throw new Error(`"${file.name}" is too large. Please choose an image under 12 MB.`);
    }

    const rawUrl = await readAsDataUrl(file);
    if (file.type === 'image/svg+xml') {
      const textContent = (await file.text()).slice(0, MAX_TEXT_CHARS);
      return {
        id: createId(),
        name: file.name,
        mimeType: 'image/svg+xml',
        size: file.size,
        kind: 'text',
        textContent,
      };
    }

    const full = await compressImage(rawUrl, file.type, 1400, 0.85);
    const thumb = await compressImage(rawUrl, 'image/jpeg', 280, 0.7);

    return {
      id: createId(),
      name: file.name,
      mimeType: full.outputMime,
      size: file.size,
      kind: 'image',
      dataBase64: full.base64,
      previewUrl: thumb.dataUrl,
    };
  }

  if (file.type === 'application/pdf' || ext === 'pdf') {
    if (file.size > MAX_PDF_BYTES) {
      throw new Error(`"${file.name}" exceeds the 2.5 MB limit for PDF uploads.`);
    }
    const dataUrl = await readAsDataUrl(file);
    const base64 = dataUrl.split(',')[1] ?? '';
    return {
      id: createId(),
      name: file.name,
      mimeType: 'application/pdf',
      size: file.size,
      kind: 'pdf',
      dataBase64: base64,
    };
  }

  const isTextLike =
    file.type.startsWith('text/') ||
    file.type === 'application/json' ||
    file.type === 'application/xml' ||
    file.type === 'application/javascript' ||
    TEXT_EXTENSIONS.has(ext);

  if (isTextLike) {
    if (file.size > MAX_TEXT_FILE_BYTES) {
      throw new Error(`"${file.name}" exceeds the 1.5 MB limit for document files.`);
    }
    const rawText = await file.text();
    return {
      id: createId(),
      name: file.name,
      mimeType: file.type || 'text/plain',
      size: file.size,
      kind: 'text',
      textContent: rawText.slice(0, MAX_TEXT_CHARS),
    };
  }

  throw new Error(
    `Unsupported file "${file.name}". Upload images (PNG/JPG/WEBP), PDFs, or text/code/CSV/JSON files.`
  );
}
