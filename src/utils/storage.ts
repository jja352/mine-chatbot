import type {
  AssistantMode,
  AttachmentItem,
  ChatMessage,
  Conversation,
  GeneratedImageItem,
  MemoryNote,
  StorageSaveResult,
  ThemeMode,
  WebSource,
} from '../types/chat';

const CONVERSATIONS_KEY = 'lumen_chat_conversations_v1';
const ACTIVE_CONVERSATION_KEY = 'lumen_chat_active_id_v1';
const THEME_KEY = 'lumen_chat_theme_v1';
const MEMORIES_KEY = 'lumen_chat_memories_v1';
const MODE_KEY = 'lumen_chat_mode_v1';

export function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function deriveTitleFromMessage(text: string): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return 'New Conversation';
  if (cleaned.length <= 44) return cleaned;

  const sliced = cleaned.slice(0, 44);
  const lastSpace = sliced.lastIndexOf(' ');
  return `${(lastSpace > 20 ? sliced.slice(0, lastSpace) : sliced).trim()}…`;
}

export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (isSameDay) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function formatRelativeTime(timestamp: number): string {
  const diffSeconds = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSeconds < 60) return 'Just now';
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function sanitizeAttachmentForStorage(att: unknown): AttachmentItem | null {
  if (!att || typeof att !== 'object') return null;
  const raw = att as Partial<AttachmentItem>;
  if (
    typeof raw.id !== 'string' ||
    typeof raw.name !== 'string' ||
    typeof raw.mimeType !== 'string' ||
    (raw.kind !== 'image' && raw.kind !== 'pdf' && raw.kind !== 'text')
  ) {
    return null;
  }

  // Omit multi-MB raw base64 payloads from localStorage; keep small image thumbnails & text snippets
  const safePreview =
    typeof raw.previewUrl === 'string' && raw.previewUrl.length <= 120_000
      ? raw.previewUrl
      : undefined;
  const safeText =
    typeof raw.textContent === 'string' ? raw.textContent.slice(0, 6_000) : undefined;

  return {
    id: raw.id,
    name: raw.name,
    mimeType: raw.mimeType,
    size: typeof raw.size === 'number' ? raw.size : 0,
    kind: raw.kind,
    previewUrl: safePreview,
    textContent: safeText,
  };
}

function sanitizeSource(src: unknown): WebSource | null {
  if (!src || typeof src !== 'object') return null;
  const raw = src as Partial<WebSource>;
  if (typeof raw.url !== 'string' || typeof raw.title !== 'string') return null;
  try {
    const parsed = new URL(raw.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return { title: raw.title, url: parsed.toString() };
  } catch {
    return null;
  }
}

function sanitizeGeneratedImage(img: unknown): GeneratedImageItem | null {
  if (!img || typeof img !== 'object') return null;
  const raw = img as Partial<GeneratedImageItem>;
  if (
    typeof raw.id !== 'string' ||
    typeof raw.dataUrl !== 'string' ||
    typeof raw.mimeType !== 'string' ||
    typeof raw.prompt !== 'string'
  ) {
    return null;
  }
  if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(raw.dataUrl)) {
    return null;
  }
  const aspectRatio =
    raw.aspectRatio === '1:1' ||
    raw.aspectRatio === '16:9' ||
    raw.aspectRatio === '9:16' ||
    raw.aspectRatio === '4:3' ||
    raw.aspectRatio === '3:4'
      ? raw.aspectRatio
      : '1:1';

  return {
    id: raw.id,
    dataUrl: raw.dataUrl,
    mimeType: raw.mimeType,
    prompt: raw.prompt,
    aspectRatio,
    model: typeof raw.model === 'string' ? raw.model : undefined,
    provider: typeof raw.provider === 'string' ? raw.provider : undefined,
  };
}

function deduplicateMessages(rawMessages: unknown): ChatMessage[] {
  if (!Array.isArray(rawMessages)) return [];
  const seenIds = new Set<string>();
  const result: ChatMessage[] = [];

  for (const item of rawMessages) {
    if (!item || typeof item !== 'object') continue;
    const msg = item as Partial<ChatMessage>;
    if (
      typeof msg.id !== 'string' ||
      (msg.role !== 'user' && msg.role !== 'assistant') ||
      typeof msg.content !== 'string' ||
      typeof msg.createdAt !== 'number'
    ) {
      continue;
    }
    if (seenIds.has(msg.id)) continue;
    seenIds.add(msg.id);

    const attachments = Array.isArray(msg.attachments)
      ? msg.attachments
          .map(sanitizeAttachmentForStorage)
          .filter((a): a is AttachmentItem => a !== null)
      : undefined;

    const sources = Array.isArray(msg.sources)
      ? msg.sources.map(sanitizeSource).filter((s): s is WebSource => s !== null)
      : undefined;

    const generatedImages = Array.isArray(msg.generatedImages)
      ? msg.generatedImages
          .map(sanitizeGeneratedImage)
          .filter((g): g is GeneratedImageItem => g !== null)
      : undefined;

    const hasImages = Boolean(generatedImages && generatedImages.length > 0);
    if (msg.role === 'assistant' && !msg.content.trim() && !hasImages && !msg.isError) {
      continue;
    }

    result.push({
      id: msg.id,
      role: msg.role,
      content: msg.content,
      thoughts: typeof msg.thoughts === 'string' && msg.thoughts ? msg.thoughts : undefined,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      generatedImages: hasImages ? generatedImages : undefined,
      sources: sources && sources.length > 0 ? sources : undefined,
      mode:
        msg.mode === 'fast' ||
        msg.mode === 'think' ||
        msg.mode === 'search' ||
        msg.mode === 'image'
          ? msg.mode
          : undefined,
      createdAt: msg.createdAt,
      updatedAt: typeof msg.updatedAt === 'number' ? msg.updatedAt : undefined,
      isError: Boolean(msg.isError),
      errorCode: typeof msg.errorCode === 'string' ? msg.errorCode : undefined,
      retryable: typeof msg.retryable === 'boolean' ? msg.retryable : undefined,
    });
  }

  return result;
}

export function deduplicateConversations(conversations: Conversation[]): Conversation[] {
  const seen = new Set<string>();
  const clean: Conversation[] = [];

  for (const conv of conversations) {
    if (!conv || typeof conv.id !== 'string' || seen.has(conv.id)) continue;
    seen.add(conv.id);
    clean.push({
      id: conv.id,
      title:
        typeof conv.title === 'string' && conv.title.trim() ? conv.title.trim() : 'Untitled Chat',
      createdAt: typeof conv.createdAt === 'number' ? conv.createdAt : Date.now(),
      updatedAt: typeof conv.updatedAt === 'number' ? conv.updatedAt : Date.now(),
      messages: deduplicateMessages(conv.messages),
    });
  }

  return clean.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadConversations(): Conversation[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(CONVERSATIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return deduplicateConversations(parsed as Conversation[]);
  } catch {
    return [];
  }
}

export function saveConversations(conversations: Conversation[]): StorageSaveResult {
  if (typeof window === 'undefined') return { ok: true };
  try {
    const deduplicated = deduplicateConversations(conversations);
    window.localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(deduplicated));
    return { ok: true };
  } catch (err) {
    const isQuota =
      err instanceof DOMException &&
      (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    return {
      ok: false,
      error: isQuota
        ? 'Browser storage quota exceeded. Delete older conversations to continue saving history.'
        : 'Unable to save chat history to browser storage.',
    };
  }
}

export function loadActiveConversationId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(ACTIVE_CONVERSATION_KEY);
  } catch {
    return null;
  }
}

export function saveActiveConversationId(id: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (id) {
      window.localStorage.setItem(ACTIVE_CONVERSATION_KEY, id);
    } else {
      window.localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
    }
  } catch {
    // Ignore storage write errors for active pointer
  }
}

export function loadTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
  } catch {
    // Default to light
  }
  return 'light';
}

export function saveTheme(theme: ThemeMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Ignore storage errors
  }
}

export function loadMemories(): MemoryNote[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(MEMORIES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is MemoryNote =>
        Boolean(item) &&
        typeof item.id === 'string' &&
        typeof item.content === 'string' &&
        typeof item.createdAt === 'number'
    );
  } catch {
    return [];
  }
}

export function saveMemories(memories: MemoryNote[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MEMORIES_KEY, JSON.stringify(memories.slice(0, 20)));
  } catch {
    // Ignore storage errors
  }
}

export function loadAssistantMode(): AssistantMode {
  if (typeof window === 'undefined') return 'fast';
  try {
    const stored = window.localStorage.getItem(MODE_KEY);
    if (stored === 'fast' || stored === 'think' || stored === 'search' || stored === 'image') {
      return stored;
    }
  } catch {
    // Ignore storage errors
  }
  return 'fast';
}

export function saveAssistantMode(mode: AssistantMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Ignore storage errors
  }
}

export function exportConversationMarkdown(conversation: Conversation): string {
  const lines: string[] = [
    `# ${conversation.title}`,
    ``,
    `_Exported from Lumen Chat on ${new Date().toLocaleString()}_`,
    ``,
  ];

  for (const msg of conversation.messages) {
    const speaker = msg.role === 'user' ? '## You' : '## Lumen Assistant';
    lines.push(speaker, '');
    if (msg.attachments && msg.attachments.length > 0) {
      lines.push(
        `Attachments: ${msg.attachments.map((a) => `${a.name} (${a.mimeType})`).join(', ')}`,
        ''
      );
    }
    if (msg.generatedImages && msg.generatedImages.length > 0) {
      lines.push(
        ...msg.generatedImages.map(
          (img) => `_Generated Image (${img.aspectRatio}): ${img.prompt}_`
        ),
        ''
      );
    }
    if (msg.thoughts) {
      lines.push('<details>', '<summary>Thought process</summary>', '', msg.thoughts, '', '</details>', '');
    }
    lines.push(msg.content, '');
    if (msg.sources && msg.sources.length > 0) {
      lines.push('**Sources:**');
      for (const src of msg.sources) {
        lines.push(`- [${src.title}](${src.url})`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
