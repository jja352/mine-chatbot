export type MessageRole = 'user' | 'assistant';

export type ThemeMode = 'light' | 'dark';

export type AssistantMode = 'fast' | 'think' | 'search' | 'image';

export type ImageAspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4';

export type AttachmentKind = 'image' | 'pdf' | 'text';

export interface AttachmentItem {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  dataBase64?: string;
  textContent?: string;
  previewUrl?: string;
}

export interface GeneratedImageItem {
  id: string;
  dataUrl: string;
  mimeType: string;
  prompt: string;
  aspectRatio: ImageAspectRatio;
  model?: string;
  provider?: string;
}

export interface WebSource {
  title: string;
  url: string;
}

export interface MemoryNote {
  id: string;
  content: string;
  createdAt: number;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  thoughts?: string;
  attachments?: AttachmentItem[];
  generatedImages?: GeneratedImageItem[];
  sources?: WebSource[];
  mode?: AssistantMode;
  createdAt: number;
  updatedAt?: number;
  isError?: boolean;
  errorCode?: string;
  retryable?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface StorageSaveResult {
  ok: boolean;
  error?: string;
}
