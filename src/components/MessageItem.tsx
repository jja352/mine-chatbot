import { memo, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FileCode2,
  FileText,
  Globe,
  Image as ImageIcon,
  Loader2,
  Pencil,
  RotateCcw,
  Square,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
import { synthesizeSpeech } from '../services/chatApi';
import type { ChatMessage } from '../types/chat';
import { formatFileSize } from '../utils/files';
import { formatTimestamp } from '../utils/storage';
import { MarkdownRenderer } from './MarkdownRenderer';

interface MessageItemProps {
  message: ChatMessage;
  isStreaming: boolean;
  isLastAssistant: boolean;
  disabled: boolean;
  onEditMessage: (id: string, newContent: string, regenerateAfterSave: boolean) => void;
  onDeleteMessage: (id: string) => void;
  onRegenerate: (messageId: string) => void;
  onCreateSvgFallback?: (messageId: string) => void;
}

export const MessageItem = memo(function MessageItem({
  message,
  isStreaming,
  isLastAssistant,
  disabled,
  onEditMessage,
  onDeleteMessage,
  onRegenerate,
  onCreateSvgFallback,
}: MessageItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftContent, setDraftContent] = useState(message.content);
  const [copied, setCopied] = useState(false);
  const [thoughtsOpen, setThoughtsOpen] = useState(false);
  const [ttsState, setTtsState] = useState<'idle' | 'loading' | 'playing'>('idle');

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 260)}px`;
    }
  }, [isEditing]);

  // Auto-open thought drawer while reasoning is actively streaming before final text arrives
  useEffect(() => {
    if (isStreaming && message.thoughts && !message.content) {
      setThoughtsOpen(true);
    }
  }, [isStreaming, message.thoughts, message.content]);

  const stopSpeech = () => {
    ttsAbortRef.current?.abort();
    ttsAbortRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setTtsState('idle');
  };

  useEffect(() => {
    return () => {
      stopSpeech();
    };
  }, []);

  const handleToggleSpeech = async () => {
    if (ttsState !== 'idle') {
      stopSpeech();
      return;
    }
    if (!message.content.trim()) return;

    setTtsState('loading');
    const controller = new AbortController();
    ttsAbortRef.current = controller;

    try {
      const { audioDataUrl } = await synthesizeSpeech(message.content, controller.signal);
      if (controller.signal.aborted) return;

      const audio = new Audio(audioDataUrl);
      audioRef.current = audio;
      audio.onended = () => {
        audioRef.current = null;
        setTtsState('idle');
      };
      audio.onerror = () => {
        audioRef.current = null;
        setTtsState('idle');
      };
      setTtsState('playing');
      await audio.play();
    } catch {
      if (controller.signal.aborted) return;
      // Seamless fallback to browser SpeechSynthesis
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        try {
          window.speechSynthesis.cancel();
          const utterance = new SpeechSynthesisUtterance(
            message.content.replace(/```[\s\S]*?```/g, 'Code snippet.').slice(0, 1800)
          );
          utterance.onend = () => setTtsState('idle');
          utterance.onerror = () => setTtsState('idle');
          setTtsState('playing');
          window.speechSynthesis.speak(utterance);
          return;
        } catch {
          // Ignore synthesis failure
        }
      }
      setTtsState('idle');
    }
  };

  const handleSaveGeneratedImage = (dataUrl: string, mimeType: string, idx: number) => {
    const ext = mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : 'png';
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `lumen-image-${idx + 1}.${ext}`;
    link.click();
  };

  const handleCopy = async () => {
    if (!message.content) return;
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ignore clipboard failures
    }
  };

  const handleStartEdit = () => {
    setDraftContent(message.content);
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setDraftContent(message.content);
    setIsEditing(false);
  };

  const handleSaveEdit = (regenerateAfterSave: boolean) => {
    const trimmed = draftContent.trim();
    if (!trimmed) return;
    setIsEditing(false);
    onEditMessage(message.id, trimmed, regenerateAfterSave);
  };

  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="group flex flex-col items-end">
        <div className="w-full max-w-[88%] sm:max-w-[75%]">
          {isEditing ? (
            <div className="rounded-2xl border border-blue-500 bg-white p-3 sm:p-3.5 shadow-xs dark:bg-slate-900">
              <textarea
                ref={textareaRef}
                value={draftContent}
                onChange={(e) => {
                  setDraftContent(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 260)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    handleCancelEdit();
                  } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleSaveEdit(true);
                  }
                }}
                rows={2}
                aria-label="Edit user message"
                className="w-full resize-none bg-transparent text-base sm:text-[15px] leading-relaxed text-slate-900 focus:outline-none dark:text-slate-100"
              />
              <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={handleCancelEdit}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <X className="h-3.5 w-3.5" />
                  <span>Cancel</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleSaveEdit(false)}
                  disabled={!draftContent.trim()}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-800 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                >
                  <Check className="h-3.5 w-3.5" />
                  <span>Save</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleSaveEdit(true)}
                  disabled={!draftContent.trim() || disabled}
                  className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Save &amp; Regenerate</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-end">
              {message.attachments && message.attachments.length > 0 && (
                <div className="mb-2 flex flex-wrap justify-end gap-2">
                  {message.attachments.map((att) =>
                    att.kind === 'image' && att.previewUrl ? (
                      <div
                        key={att.id}
                        className="overflow-hidden rounded-xl border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800"
                      >
                        <img
                          src={att.previewUrl}
                          alt={att.name}
                          className="max-h-40 max-w-[200px] object-cover"
                        />
                      </div>
                    ) : (
                      <div
                        key={att.id}
                        className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                      >
                        {att.kind === 'pdf' ? (
                          <FileText className="h-4 w-4 shrink-0 text-red-500" />
                        ) : (
                          <FileCode2 className="h-4 w-4 shrink-0 text-blue-500" />
                        )}
                        <div className="max-w-[160px]">
                          <div className="truncate font-medium">{att.name}</div>
                          <div className="text-[11px] text-slate-400 tabular-nums">
                            {formatFileSize(att.size)}
                          </div>
                        </div>
                      </div>
                    )
                  )}
                </div>
              )}

              <div className="max-w-full rounded-2xl rounded-br-sm border border-slate-200/80 bg-slate-100 px-3.5 py-2.5 sm:px-4 sm:py-3 text-[15px] leading-[1.6] text-slate-900 whitespace-pre-wrap break-words [overflow-wrap:anywhere] dark:border-slate-700/70 dark:bg-slate-800 dark:text-slate-100">
                {message.content}
              </div>

              <div className="mt-1.5 flex items-center gap-1.5 sm:gap-2 text-xs text-slate-400 tabular-nums dark:text-slate-500">
                <div className="flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="flex h-9 w-9 sm:h-7 sm:w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                    aria-label="Copy message"
                    title="Copy"
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={handleStartEdit}
                    disabled={disabled}
                    className="flex h-9 w-9 sm:h-7 sm:w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                    aria-label="Edit message"
                    title="Edit"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteMessage(message.id)}
                    disabled={disabled}
                    className="flex h-9 w-9 sm:h-7 sm:w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-40 dark:hover:bg-red-950/60 dark:hover:text-red-400"
                    aria-label="Delete message"
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <span>{formatTimestamp(message.createdAt)}</span>
                {message.updatedAt && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>Edited</span>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Assistant message
  const isThinkingPhase = isStreaming && message.content.length === 0;

  return (
    <div className="group flex items-start gap-2.5 sm:gap-3.5">
      <div
        className={`mt-0.5 flex h-7 w-7 sm:h-8 sm:w-8 shrink-0 items-center justify-center rounded-lg border ${
          message.isError
            ? 'border-red-200 bg-red-50 text-red-600 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-400'
            : 'border-slate-200 bg-white text-blue-600 dark:border-slate-800 dark:bg-slate-900 dark:text-blue-400'
        }`}
        aria-hidden="true"
      >
        {message.isError ? (
          <AlertCircle className="h-4 w-4" />
        ) : (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            className="h-3.5 w-3.5 sm:h-4 sm:w-4"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2L12 3z" />
          </svg>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {isEditing ? (
          <div className="rounded-2xl border border-blue-500 bg-white p-3 sm:p-3.5 shadow-xs dark:bg-slate-900">
            <textarea
              ref={textareaRef}
              value={draftContent}
              onChange={(e) => {
                setDraftContent(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 260)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  handleCancelEdit();
                } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSaveEdit(false);
                }
              }}
              rows={3}
              aria-label="Edit assistant message"
              className="w-full resize-none bg-transparent text-base sm:text-[15px] leading-relaxed text-slate-900 focus:outline-none dark:text-slate-100"
            />
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleCancelEdit}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <X className="h-3.5 w-3.5" />
                <span>Cancel</span>
              </button>
              <button
                type="button"
                onClick={() => handleSaveEdit(false)}
                disabled={!draftContent.trim()}
                className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />
                <span>Save</span>
              </button>
            </div>
          </div>
        ) : message.isError ? (
          <div className="rounded-xl border border-red-200 bg-red-50/80 px-4 py-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/35 dark:text-red-200">
            <p className="font-medium">Could not generate response</p>
            <p className="mt-1 text-red-700 dark:text-red-300">{message.content}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {message.retryable !== false && (
                <button
                  type="button"
                  onClick={() => onRegenerate(message.id)}
                  disabled={disabled}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Retry</span>
                </button>
              )}
              {(message.errorCode === 'PAID_KEY_REQUIRED' ||
                message.errorCode === 'EDIT_NOT_SUPPORTED' ||
                message.mode === 'image') &&
                onCreateSvgFallback && (
                  <button
                    type="button"
                    onClick={() => onCreateSvgFallback(message.id)}
                    disabled={disabled}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-red-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    <ImageIcon className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                    <span>Create SVG Diagram Instead</span>
                  </button>
                )}
              <button
                type="button"
                onClick={() => onDeleteMessage(message.id)}
                disabled={disabled}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:bg-slate-900 dark:text-red-300 dark:hover:bg-red-950/50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Dismiss</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Collapsible Reasoning / Thought Process Block */}
            {message.thoughts && (
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900/60">
                <button
                  type="button"
                  onClick={() => setThoughtsOpen((prev) => !prev)}
                  className="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left text-xs font-medium text-slate-600 transition-colors hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
                  aria-expanded={thoughtsOpen}
                >
                  <span className="flex items-center gap-2">
                    <BrainCircuit className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                    <span>
                      {isThinkingPhase ? 'Thinking deeply…' : 'Thought process'}
                    </span>
                  </span>
                  {thoughtsOpen ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  )}
                </button>
                {thoughtsOpen && (
                  <div className="border-t border-slate-200/80 px-3.5 py-2.5 text-xs leading-relaxed text-slate-600 whitespace-pre-wrap break-words dark:border-slate-800 dark:text-slate-400">
                    {message.thoughts}
                  </div>
                )}
              </div>
            )}

            {isThinkingPhase && !message.thoughts ? (
              message.mode === 'image' ? (
                <div
                  className="max-w-sm rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900"
                  role="status"
                  aria-label="Generating AI image"
                >
                  <div className="flex aspect-square w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-slate-300 bg-white/70 dark:border-slate-700 dark:bg-slate-950/50">
                    <Loader2 className="h-6 w-6 animate-spin text-blue-600 dark:text-blue-400" />
                    <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                      Generating image…
                    </span>
                  </div>
                </div>
              ) : (
                <div
                  className="flex items-center gap-2 py-2 text-sm text-slate-500 dark:text-slate-400"
                  role="status"
                  aria-label="Gemini is generating a response"
                >
                  <div className="flex items-center gap-1">
                    <span className="typing-dot h-2 w-2 rounded-full bg-blue-600 dark:bg-blue-400" />
                    <span className="typing-dot h-2 w-2 rounded-full bg-blue-600 dark:bg-blue-400" />
                    <span className="typing-dot h-2 w-2 rounded-full bg-blue-600 dark:bg-blue-400" />
                  </div>
                  <span>
                    {message.mode === 'search'
                      ? 'Searching the web…'
                      : message.mode === 'think'
                        ? 'Reasoning…'
                        : 'Thinking…'}
                  </span>
                </div>
              )
            ) : (
              <>
                {message.generatedImages && message.generatedImages.length > 0 && (
                  <div className="space-y-3">
                    {message.generatedImages.map((img, idx) => (
                      <div
                        key={img.id}
                        className="max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 shadow-xs dark:border-slate-800 dark:bg-slate-900"
                      >
                        <img
                          src={img.dataUrl}
                          alt={img.prompt}
                          className="max-h-[420px] w-full object-contain bg-white dark:bg-slate-950"
                        />
                        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-3.5 py-2.5 text-xs dark:border-slate-800">
                          <span className="truncate text-slate-500 dark:text-slate-400">
                            {img.aspectRatio}
                            {img.provider ? ` · ${img.provider}` : ''}
                            {img.model ? ` · ${img.model}` : ''}
                          </span>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => onRegenerate(message.id)}
                              disabled={disabled}
                              className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              <span>Regenerate</span>
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                handleSaveGeneratedImage(img.dataUrl, img.mimeType, idx)
                              }
                              className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg bg-blue-600 px-2.5 py-1 font-medium text-white transition-colors hover:bg-blue-700"
                            >
                              <Download className="h-3.5 w-3.5" />
                              <span>Save</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {message.content ? (
                  <MarkdownRenderer content={message.content} />
                ) : !message.generatedImages?.length && !isStreaming ? (
                  <p className="text-sm italic text-slate-400 dark:text-slate-500">
                    No response was generated. Click Regenerate below to try again.
                  </p>
                ) : null}
              </>
            )}

            {/* Grounded Web Sources */}
            {!isStreaming && message.sources && message.sources.length > 0 && (
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-900/60">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                  <Globe className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                  <span>Sources</span>
                </div>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {message.sources.map((src) => {
                    let host = src.url;
                    try {
                      host = new URL(src.url).hostname.replace(/^www\./, '');
                    } catch {
                      // fallback to raw url
                    }
                    return (
                      <a
                        key={src.url}
                        href={src.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs transition-colors hover:border-blue-300 hover:text-blue-600 dark:border-slate-700/80 dark:bg-slate-950/60 dark:hover:border-blue-700 dark:hover:text-blue-400"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium text-slate-800 dark:text-slate-200">
                            {src.title}
                          </div>
                          <div className="truncate text-[11px] text-slate-400">{host}</div>
                        </div>
                        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                      </a>
                    );
                  })}
                </div>
              </div>
            )}

            {!isStreaming && (
              <div className="mt-2 flex items-center gap-2 text-xs text-slate-400 tabular-nums dark:text-slate-500">
                <span>{formatTimestamp(message.createdAt)}</span>
                {message.updatedAt && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>Edited</span>
                  </>
                )}
                <div className="flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                  <button
                    type="button"
                    onClick={handleToggleSpeech}
                    className="flex h-9 w-9 sm:h-7 sm:w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                    aria-label={ttsState === 'playing' ? 'Stop reading aloud' : 'Read response aloud'}
                    title={ttsState === 'playing' ? 'Stop' : 'Read aloud'}
                  >
                    {ttsState === 'loading' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600 dark:text-blue-400" />
                    ) : ttsState === 'playing' ? (
                      <Square className="h-3 w-3 fill-current text-blue-600 dark:text-blue-400" />
                    ) : (
                      <Volume2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="flex h-9 w-9 sm:h-7 sm:w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                    aria-label="Copy response"
                    title="Copy"
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={handleStartEdit}
                    disabled={disabled}
                    className="flex h-9 w-9 sm:h-7 sm:w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                    aria-label="Edit response"
                    title="Edit"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  {isLastAssistant && (
                    <button
                      type="button"
                      onClick={() => onRegenerate(message.id)}
                      disabled={disabled}
                      className="flex h-9 w-9 sm:h-7 sm:w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                      aria-label="Regenerate response"
                      title="Regenerate"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onDeleteMessage(message.id)}
                    disabled={disabled}
                    className="flex h-9 w-9 sm:h-7 sm:w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-40 dark:hover:bg-red-950/60 dark:hover:text-red-400"
                    aria-label="Delete response"
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
