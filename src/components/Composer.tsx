import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  BrainCircuit,
  FileCode2,
  FileText,
  Globe,
  Image as ImageIcon,
  Mic,
  MicOff,
  Paperclip,
  Square,
  X,
  Zap,
} from 'lucide-react';
import type { AssistantMode, AttachmentItem, ImageAspectRatio } from '../types/chat';
import { formatFileSize, processSelectedFile } from '../utils/files';

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

interface ComposerProps {
  resetKey: string;
  isGenerating: boolean;
  mode: AssistantMode;
  onModeChange: (mode: AssistantMode) => void;
  onSend: (
    message: string,
    attachments?: AttachmentItem[],
    overrideMode?: AssistantMode,
    aspectRatio?: ImageAspectRatio
  ) => void;
  onStop: () => void;
  onInputFocus?: () => void;
}

const ASPECT_RATIOS: ImageAspectRatio[] = ['1:1', '16:9', '9:16', '4:3', '3:4'];

const MODE_OPTIONS: {
  id: AssistantMode;
  label: string;
  shortLabel: string;
  description: string;
  icon: typeof Zap;
}[] = [
  {
    id: 'fast',
    label: 'Fast',
    shortLabel: 'Fast',
    description: 'Instant responses (Gemini Flash Lite)',
    icon: Zap,
  },
  {
    id: 'think',
    label: 'Deep Think',
    shortLabel: 'Think',
    description: 'Step-by-step reasoning & complex coding',
    icon: BrainCircuit,
  },
  {
    id: 'search',
    label: 'Web Search',
    shortLabel: 'Search',
    description: 'Live Google Search grounding & citations',
    icon: Globe,
  },
  {
    id: 'image',
    label: 'Image',
    shortLabel: 'Image',
    description: 'Generate or edit AI images',
    icon: ImageIcon,
  },
];

export const Composer = memo(function Composer({
  resetKey,
  isGenerating,
  mode,
  onModeChange,
  onSend,
  onStop,
  onInputFocus,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const [aspectRatio, setAspectRatio] = useState<ImageAspectRatio>('1:1');
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isListening, setIsListening] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const speechCtor =
    typeof window !== 'undefined'
      ? ((window as unknown as {
          SpeechRecognition?: SpeechRecognitionConstructor;
          webkitSpeechRecognition?: SpeechRecognitionConstructor;
        }).SpeechRecognition ??
          (window as unknown as {
            webkitSpeechRecognition?: SpeechRecognitionConstructor;
          }).webkitSpeechRecognition)
      : undefined;

  useEffect(() => {
    setValue('');
    setAttachments([]);
    setAttachmentError(null);
  }, [resetKey]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
    };
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  const addFiles = useCallback(async (fileList: FileList | File[]) => {
    setAttachmentError(null);
    const incoming = Array.from(fileList);
    if (incoming.length === 0) return;

    const processed: AttachmentItem[] = [];
    for (const file of incoming) {
      if (processed.length + attachments.length >= 4) {
        setAttachmentError('You can attach up to 4 files per message.');
        break;
      }
      try {
        const item = await processSelectedFile(file);
        processed.push(item);
      } catch (err) {
        setAttachmentError(err instanceof Error ? err.message : 'Failed to attach file.');
      }
    }

    if (processed.length > 0) {
      setAttachments((prev) => [...prev, ...processed].slice(0, 4));
    }
  }, [attachments.length]);

  const toggleVoiceInput = () => {
    if (!speechCtor) {
      setAttachmentError('Voice input is not supported in this browser. Try Chrome or Edge.');
      return;
    }

    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    setAttachmentError(null);
    try {
      const recognition = new speechCtor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || 'en-US';

      const baseDraft = value.trim() ? `${value.trim()} ` : '';
      let finalTranscript = '';

      recognition.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const chunk = event.results[i][0]?.transcript ?? '';
          if (event.results[i].isFinal) {
            finalTranscript += chunk;
          } else {
            interim += chunk;
          }
        }
        setValue(`${baseDraft}${finalTranscript}${interim}`.trimStart());
      };

      recognition.onerror = () => {
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
      recognition.start();
      setIsListening(true);
    } catch {
      setIsListening(false);
      setAttachmentError('Unable to access microphone for voice input.');
    }
  };

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !isGenerating;

  const submitDraft = () => {
    const trimmed = value.trim();
    if ((!trimmed && attachments.length === 0) || isGenerating) return;
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
    }
    const outgoingAttachments = attachments.length > 0 ? [...attachments] : undefined;
    setValue('');
    setAttachments([]);
    setAttachmentError(null);
    onSend(trimmed, outgoingAttachments, undefined, aspectRatio);
  };

  return (
    <div
      className="shrink-0 border-t border-slate-200 bg-white/95 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-xs sm:px-6 sm:pt-2.5 sm:pb-4 dark:border-slate-800 dark:bg-slate-950/95"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        if (e.dataTransfer.files?.length) {
          void addFiles(e.dataTransfer.files);
        }
      }}
    >
      <div className="mx-auto max-w-3xl">
        {/* Mode Switcher */}
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div
            className="inline-flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1 dark:border-slate-800 dark:bg-slate-900"
            role="radiogroup"
            aria-label="Assistant mode"
          >
            {MODE_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const active = mode === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onModeChange(opt.id)}
                  title={opt.description}
                  className={`inline-flex min-h-[32px] items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-white text-blue-600 shadow-xs dark:bg-slate-800 dark:text-blue-400'
                      : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden sm:inline">{opt.label}</span>
                  <span className="sm:hidden">{opt.shortLabel}</span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            {mode === 'image' && (
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                <span className="hidden sm:inline">Ratio:</span>
                <select
                  value={aspectRatio}
                  onChange={(e) => setAspectRatio(e.target.value as ImageAspectRatio)}
                  aria-label="Image aspect ratio"
                  className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                >
                  {ASPECT_RATIOS.map((ratio) => (
                    <option key={ratio} value={ratio}>
                      {ratio}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {isListening && (
              <span className="text-xs font-medium text-red-600 dark:text-red-400">
                Listening…
              </span>
            )}
          </div>
        </div>

        {/* Attachment Error */}
        {attachmentError && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            <span>{attachmentError}</span>
            <button
              type="button"
              onClick={() => setAttachmentError(null)}
              className="rounded p-0.5 hover:bg-amber-200/50 dark:hover:bg-amber-900/50"
              aria-label="Dismiss file notice"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Composer Box */}
        <div
          className={`rounded-2xl border transition-colors ${
            isDragging
              ? 'border-blue-500 bg-blue-50/40 ring-2 ring-blue-500/20 dark:bg-blue-950/20'
              : 'border-slate-200 bg-slate-50 focus-within:border-blue-500 focus-within:bg-white focus-within:ring-2 focus-within:ring-blue-500/15 dark:border-slate-800 dark:bg-slate-900 dark:focus-within:border-blue-500 dark:focus-within:bg-slate-900'
          }`}
        >
          {/* Pending Attachments Preview Strip */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 border-b border-slate-200/80 px-3 pt-2.5 pb-2 dark:border-slate-800">
              {attachments.map((att) => (
                <div
                  key={att.id}
                  className="group relative flex items-center gap-2 rounded-xl border border-slate-200 bg-white pr-1.5 pl-2 py-1.5 text-xs shadow-2xs dark:border-slate-700 dark:bg-slate-800"
                >
                  {att.kind === 'image' && att.previewUrl ? (
                    <img
                      src={att.previewUrl}
                      alt={att.name}
                      className="h-8 w-8 rounded-lg object-cover"
                    />
                  ) : att.kind === 'pdf' ? (
                    <FileText className="h-4 w-4 shrink-0 text-red-500" />
                  ) : (
                    <FileCode2 className="h-4 w-4 shrink-0 text-blue-500" />
                  )}
                  <div className="max-w-[140px]">
                    <div className="truncate font-medium text-slate-800 dark:text-slate-100">
                      {att.name}
                    </div>
                    <div className="text-[10px] text-slate-400 tabular-nums">
                      {formatFileSize(att.size)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((item) => item.id !== att.id))}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-200"
                    aria-label={`Remove ${att.name}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end gap-1.5 p-1.5 sm:p-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,application/pdf,text/*,.md,.csv,.json,.ts,.tsx,.js,.jsx,.py,.sql,.html,.css,.xml,.yaml,.yml,.log"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) {
                  void addFiles(e.target.files);
                  e.target.value = '';
                }
              }}
            />

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isGenerating}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-900 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:h-10 sm:w-10 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              aria-label="Attach image, PDF, or document"
              title="Attach image, PDF, or code/data file"
            >
              <Paperclip className="h-4.5 w-4.5" />
            </button>

            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onFocus={onInputFocus}
              onPaste={(e) => {
                const files = e.clipboardData?.files;
                if (files && files.length > 0) {
                  e.preventDefault();
                  void addFiles(files);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (canSend) {
                    submitDraft();
                  }
                }
              }}
              placeholder={
                mode === 'image'
                  ? 'Describe the image you want to generate or edit…'
                  : mode === 'search'
                    ? 'Ask anything to search the live web…'
                    : mode === 'think'
                      ? 'Ask a complex coding, math, or strategy question…'
                      : 'Message Lumen in English, اردو, or Roman Urdu…'
              }
              rows={1}
              aria-label="Chat message input"
              className="max-h-[160px] min-h-[44px] flex-1 resize-none bg-transparent px-1.5 py-2.5 text-base leading-relaxed text-slate-900 placeholder:text-slate-400 focus:outline-none sm:min-h-[42px] sm:py-2 sm:text-[15px] dark:text-slate-100 dark:placeholder:text-slate-500"
            />

            <button
              type="button"
              onClick={toggleVoiceInput}
              disabled={isGenerating}
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:h-10 sm:w-10 disabled:opacity-40 ${
                isListening
                  ? 'bg-red-100 text-red-600 hover:bg-red-200 dark:bg-red-950/70 dark:text-red-400'
                  : 'text-slate-500 hover:bg-slate-200/70 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100'
              }`}
              aria-label={isListening ? 'Stop voice input' : 'Start voice input'}
              title={isListening ? 'Stop voice input' : 'Voice input'}
            >
              {isListening ? <MicOff className="h-4.5 w-4.5" /> : <Mic className="h-4.5 w-4.5" />}
            </button>

            {isGenerating ? (
              <button
                type="button"
                onClick={onStop}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white transition-colors hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:h-10 sm:w-10 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-300"
                aria-label="Stop generating"
                title="Stop generating"
              >
                <Square className="h-4 w-4 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submitDraft}
                disabled={!canSend}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:h-10 sm:w-10 dark:disabled:bg-slate-800 dark:disabled:text-slate-600"
                aria-label="Send message"
                title="Send message"
              >
                <ArrowUp className="h-4.5 w-4.5 sm:h-4 sm:w-4" strokeWidth={2.25} />
              </button>
            )}
          </div>
        </div>

        <p className="mt-1.5 hidden text-center text-xs text-slate-400 sm:block dark:text-slate-500">
          Enter to send · Shift + Enter for new line · Drop or paste images, PDFs &amp; code files
        </p>
      </div>
    </div>
  );
});
