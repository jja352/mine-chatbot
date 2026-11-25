import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  Brain,
  Check,
  Download,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  SquarePen,
  Sun,
  X,
} from 'lucide-react';
import { Composer } from './components/Composer';
import { ConfirmModal } from './components/ConfirmModal';
import { MemoryModal } from './components/MemoryModal';
import { MessageItem } from './components/MessageItem';
import { Sidebar } from './components/Sidebar';
import { ChatApiError, generateImageRequest, streamChatResponse } from './services/chatApi';
import type {
  AssistantMode,
  AttachmentItem,
  ChatMessage,
  Conversation,
  GeneratedImageItem,
  ImageAspectRatio,
  MemoryNote,
  ThemeMode,
  WebSource,
} from './types/chat';
import { resolveRequestIntent } from './utils/intent';
import {
  createId,
  deriveTitleFromMessage,
  exportConversationMarkdown,
  loadActiveConversationId,
  loadAssistantMode,
  loadConversations,
  loadMemories,
  loadTheme,
  saveActiveConversationId,
  saveAssistantMode,
  saveConversations,
  saveMemories,
  saveTheme,
} from './utils/storage';

const STARTER_PROMPTS: {
  title: string;
  subtitle: string;
  prompt: string;
  mode?: AssistantMode;
}[] = [
  {
    title: 'Build & debug code',
    subtitle: 'Full-stack TypeScript, React, Python, SQL & bug fixes',
    prompt:
      'Write a clean, production-ready TypeScript debounce hook for React with cleanup and explain a common pitfall to avoid.',
    mode: 'fast',
  },
  {
    title: 'Step-by-step business roadmap',
    subtitle: 'Strategy, milestones, tables & deep reasoning',
    prompt:
      'Create a practical 90-day launch roadmap for a SaaS MVP, organized in a clear Markdown table with weekly milestones.',
    mode: 'think',
  },
  {
    title: 'Live web research',
    subtitle: 'Up-to-date answers with verified web citations',
    prompt:
      'What are the latest key updates and best practices in React and Next.js web development right now? Include sources.',
    mode: 'search',
  },
  {
    title: 'English, Urdu & Roman Urdu',
    subtitle: 'Natural multilingual chat, rewriting & translation',
    prompt:
      'Mujhe AI aur software engineering seekhne ka ek simple, step-by-step beginner plan Roman Urdu mein samjhao.',
    mode: 'fast',
  },
];

type DeleteTarget =
  | { kind: 'single'; conversation: Conversation }
  | { kind: 'all' }
  | null;

function getInitialWorkspace(): { conversations: Conversation[]; activeId: string | null } {
  const savedList = loadConversations();
  const savedActive = loadActiveConversationId();
  const activeId =
    savedActive && savedList.some((c) => c.id === savedActive)
      ? savedActive
      : savedList[0]?.id ?? null;
  return { conversations: savedList, activeId };
}

export default function App() {
  const [initialWorkspace] = useState(getInitialWorkspace);
  const [conversations, setConversations] = useState<Conversation[]>(
    initialWorkspace.conversations
  );
  const [activeId, setActiveId] = useState<string | null>(initialWorkspace.activeId);

  const [theme, setTheme] = useState<ThemeMode>(() => loadTheme());
  const [mode, setMode] = useState<AssistantMode>(() => loadAssistantMode());
  const [memories, setMemories] = useState<MemoryNote[]>(() => loadMemories());
  const [isMemoryOpen, setIsMemoryOpen] = useState(false);

  const [streamingConvId, setStreamingConvId] = useState<string | null>(null);
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [composerResetNonce, setComposerResetNonce] = useState(0);

  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isDesktopSidebarCollapsed, setIsDesktopSidebarCollapsed] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);

  const [isHeaderRenaming, setIsHeaderRenaming] = useState(false);
  const [headerDraftTitle, setHeaderDraftTitle] = useState('');
  const [showScrollButton, setShowScrollButton] = useState(false);

  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const streamingConvIdRef = useRef(streamingConvId);
  streamingConvIdRef.current = streamingConvId;

  const modeRef = useRef(mode);
  modeRef.current = mode;

  const memoriesRef = useRef(memories);
  memoriesRef.current = memories;

  const abortControllerRef = useRef<AbortController | null>(null);
  const isGeneratingRef = useRef(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const headerInputRef = useRef<HTMLInputElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const scrollRafRef = useRef<number | null>(null);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId]
  );

  // Sync dark mode class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    saveTheme(theme);
  }, [theme]);

  useEffect(() => {
    saveAssistantMode(mode);
  }, [mode]);

  useEffect(() => {
    saveMemories(memories);
  }, [memories]);

  // Persist conversations to Local Storage (defer during active token streaming)
  useEffect(() => {
    if (streamingMsgId !== null) return;
    const result = saveConversations(conversations);
    if (!result.ok && result.error) {
      setStorageError(result.error);
    } else {
      setStorageError(null);
    }
  }, [conversations, streamingMsgId]);

  useEffect(() => {
    saveActiveConversationId(activeId);
  }, [activeId]);

  useEffect(() => {
    if (isHeaderRenaming && headerInputRef.current) {
      headerInputRef.current.focus();
      headerInputRef.current.select();
    }
  }, [isHeaderRenaming]);

  useEffect(() => {
    setIsHeaderRenaming(false);
    shouldAutoScrollRef.current = true;
    setShowScrollButton(false);
  }, [activeId]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
    }
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      messagesEndRef.current?.scrollIntoView({ behavior, block: 'end' });
    });
  }, []);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      scrollToBottom(streamingMsgId ? 'auto' : 'smooth');
    }
  }, [activeConversation?.messages, streamingMsgId, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const nearBottom = distanceFromBottom < 120;
    shouldAutoScrollRef.current = nearBottom;
    const msgCount =
      conversationsRef.current.find((c) => c.id === activeIdRef.current)?.messages.length ?? 0;
    setShowScrollButton(!nearBottom && msgCount > 0);
  }, []);

  const handleStopGenerating = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    isGeneratingRef.current = false;
    setStreamingConvId(null);
    setStreamingMsgId(null);
  }, []);

  const handleNewChat = useCallback(() => {
    if (isGeneratingRef.current) {
      handleStopGenerating();
    }
    setActiveId(null);
    setComposerResetNonce((n) => n + 1);
    setIsHeaderRenaming(false);
  }, [handleStopGenerating]);

  const runGeminiTurn = useCallback(
    async ({
      conversationId,
      userPrompt,
      history,
      assistantMsgId,
      attachments,
      turnMode,
    }: {
      conversationId: string;
      userPrompt: string;
      history: ChatMessage[];
      assistantMsgId: string;
      attachments?: AttachmentItem[];
      turnMode?: AssistantMode;
    }) => {
      if (isGeneratingRef.current) return;

      isGeneratingRef.current = true;
      setStreamingConvId(conversationId);
      setStreamingMsgId(assistantMsgId);
      shouldAutoScrollRef.current = true;

      const controller = new AbortController();
      abortControllerRef.current = controller;

      let latestText = '';
      let latestThoughts = '';
      let latestSources: WebSource[] = [];
      let chunkTimerId: number | null = null;
      let lastFlushAt = 0;
      const CHUNK_FLUSH_INTERVAL_MS = 40;

      const applyStreamState = (touchUpdatedAt: boolean) => {
        setConversations((prev) =>
          prev.map((conv) => {
            if (conv.id !== conversationId) return conv;
            return {
              ...conv,
              updatedAt: touchUpdatedAt ? Date.now() : conv.updatedAt,
              messages: conv.messages.map((msg) =>
                msg.id === assistantMsgId
                  ? {
                      ...msg,
                      content: latestText,
                      thoughts: latestThoughts || undefined,
                      sources: latestSources.length > 0 ? latestSources : undefined,
                    }
                  : msg
              ),
            };
          })
        );
      };

      const clearScheduledFlush = () => {
        if (chunkTimerId !== null) {
          window.clearTimeout(chunkTimerId);
          chunkTimerId = null;
        }
      };

      const scheduleFlush = () => {
        const nowMs = performance.now();
        if (lastFlushAt === 0 || nowMs - lastFlushAt >= CHUNK_FLUSH_INTERVAL_MS) {
          clearScheduledFlush();
          lastFlushAt = nowMs;
          applyStreamState(false);
        } else if (chunkTimerId === null) {
          const remaining = CHUNK_FLUSH_INTERVAL_MS - (nowMs - lastFlushAt);
          chunkTimerId = window.setTimeout(() => {
            chunkTimerId = null;
            lastFlushAt = performance.now();
            applyStreamState(false);
          }, remaining);
        }
      };

      try {
        const memoryTexts = memoriesRef.current.map((m) => m.content);
        const result = await streamChatResponse({
          message: userPrompt,
          history,
          mode: turnMode ?? modeRef.current,
          attachments,
          memories: memoryTexts,
          signal: controller.signal,
          onThought: (thoughts) => {
            latestThoughts = thoughts;
            scheduleFlush();
          },
          onChunk: (accumulatedText) => {
            latestText = accumulatedText;
            scheduleFlush();
          },
          onSources: (sources) => {
            latestSources = sources;
          },
        });

        clearScheduledFlush();
        latestText = result.text || latestText;
        latestThoughts = result.thoughts || latestThoughts;
        latestSources = result.sources.length > 0 ? result.sources : latestSources;
        if (!latestText.trim()) {
          throw new ChatApiError(
            'No response was received from Gemini. Please retry.',
            'EMPTY_RESPONSE',
            502,
            true
          );
        }
        applyStreamState(true);
      } catch (err) {
        clearScheduledFlush();

        if (err instanceof DOMException && err.name === 'AbortError') {
          setConversations((prev) =>
            prev.map((conv) => {
              if (conv.id !== conversationId) return conv;
              const target = conv.messages.find((m) => m.id === assistantMsgId);
              if (
                target &&
                target.content.trim() === '' &&
                latestText.trim() === '' &&
                !latestThoughts
              ) {
                return {
                  ...conv,
                  updatedAt: Date.now(),
                  messages: conv.messages.filter((m) => m.id !== assistantMsgId),
                };
              }
              return {
                ...conv,
                updatedAt: Date.now(),
                messages: conv.messages.map((m) =>
                  m.id === assistantMsgId
                    ? {
                        ...m,
                        content: latestText || m.content,
                        thoughts: latestThoughts || m.thoughts,
                      }
                    : m
                ),
              };
            })
          );
          return;
        }

        const errorMessage =
          err instanceof ChatApiError
            ? err.message
            : 'An unexpected error occurred while contacting Gemini.';
        const errorCode = err instanceof ChatApiError ? err.code : 'UNKNOWN_ERROR';
        const retryable = err instanceof ChatApiError ? err.retryable : true;

        setConversations((prev) =>
          prev.map((conv) => {
            if (conv.id !== conversationId) return conv;
            return {
              ...conv,
              updatedAt: Date.now(),
              messages: conv.messages.map((msg) =>
                msg.id === assistantMsgId
                  ? {
                      ...msg,
                      content: errorMessage,
                      isError: true,
                      errorCode,
                      retryable,
                    }
                  : msg
              ),
            };
          })
        );
      } finally {
        clearScheduledFlush();
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        isGeneratingRef.current = false;
        setStreamingConvId(null);
        setStreamingMsgId(null);
      }
    },
    []
  );

  const runImageTurn = useCallback(
    async ({
      conversationId,
      prompt,
      assistantMsgId,
      aspectRatio = '1:1',
      sourceImage,
    }: {
      conversationId: string;
      prompt: string;
      assistantMsgId: string;
      aspectRatio?: ImageAspectRatio;
      sourceImage?: { dataBase64: string; mimeType: string };
    }) => {
      if (isGeneratingRef.current) return;

      isGeneratingRef.current = true;
      setStreamingConvId(conversationId);
      setStreamingMsgId(assistantMsgId);
      shouldAutoScrollRef.current = true;

      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        const result = await generateImageRequest({
          prompt,
          aspectRatio,
          sourceImage,
          signal: controller.signal,
        });

        const generatedItem: GeneratedImageItem = {
          id: createId(),
          dataUrl: result.dataUrl,
          mimeType: result.mimeType,
          prompt,
          aspectRatio: result.aspectRatio,
          model: result.model,
          provider: result.provider,
        };

        setConversations((prev) =>
          prev.map((conv) => {
            if (conv.id !== conversationId) return conv;
            return {
              ...conv,
              updatedAt: Date.now(),
              messages: conv.messages.map((msg) =>
                msg.id === assistantMsgId
                  ? {
                      ...msg,
                      content: result.caption || '',
                      generatedImages: [generatedItem],
                      isError: false,
                    }
                  : msg
              ),
            };
          })
        );
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          setConversations((prev) =>
            prev.map((conv) => {
              if (conv.id !== conversationId) return conv;
              return {
                ...conv,
                updatedAt: Date.now(),
                messages: conv.messages.filter((m) => m.id !== assistantMsgId),
              };
            })
          );
          return;
        }

        const errorMessage =
          err instanceof ChatApiError
            ? err.message
            : 'Unable to generate image right now. Please try again.';
        const errorCode = err instanceof ChatApiError ? err.code : 'IMAGE_GENERATION_FAILED';
        const retryable = err instanceof ChatApiError ? err.retryable : true;

        setConversations((prev) =>
          prev.map((conv) => {
            if (conv.id !== conversationId) return conv;
            return {
              ...conv,
              updatedAt: Date.now(),
              messages: conv.messages.map((msg) =>
                msg.id === assistantMsgId
                  ? {
                      ...msg,
                      content: errorMessage,
                      isError: true,
                      errorCode,
                      retryable,
                    }
                  : msg
              ),
            };
          })
        );
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        isGeneratingRef.current = false;
        setStreamingConvId(null);
        setStreamingMsgId(null);
      }
    },
    []
  );

  const handleSendMessage = useCallback(
    async (
      rawPrompt: string,
      attachments?: AttachmentItem[],
      overrideMode?: AssistantMode,
      aspectRatio?: ImageAspectRatio
    ) => {
      const promptText = rawPrompt.trim();
      const hasAttachments = (attachments?.length ?? 0) > 0;
      if ((!promptText && !hasAttachments) || isGeneratingRef.current) return;

      const selectedMode = overrideMode ?? modeRef.current;
      const displayPrompt =
        promptText || `Analyze attached ${attachments!.map((a) => a.name).join(', ')}`;

      let targetConversationId = activeIdRef.current;
      const existingConv = targetConversationId
        ? conversationsRef.current.find((c) => c.id === targetConversationId)
        : undefined;
      const priorMessages = existingConv?.messages ?? [];

      const intent = resolveRequestIntent(
        displayPrompt,
        selectedMode,
        priorMessages,
        hasAttachments
      );

      // If current user turn uploaded an image in Image mode, use it as edit reference
      let inlineSourceImage = intent.sourceImage;
      if (intent.kind === 'image' && !inlineSourceImage && attachments?.length) {
        const uploadedImg = attachments.find((a) => a.kind === 'image' && a.dataBase64);
        if (uploadedImg?.dataBase64) {
          inlineSourceImage = {
            dataBase64: uploadedImg.dataBase64,
            mimeType: uploadedImg.mimeType,
          };
        }
      }

      const now = Date.now();
      const userMessage: ChatMessage = {
        id: createId(),
        role: 'user',
        content: displayPrompt,
        attachments,
        createdAt: now,
      };
      const assistantMessage: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content: '',
        mode: intent.mode,
        createdAt: now + 1,
      };

      if (!targetConversationId) {
        const newConv: Conversation = {
          id: createId(),
          title: deriveTitleFromMessage(displayPrompt),
          createdAt: now,
          updatedAt: now,
          messages: [userMessage, assistantMessage],
        };
        targetConversationId = newConv.id;
        setActiveId(newConv.id);
        setConversations((prev) => [newConv, ...prev]);
      } else {
        const isFirstUserMessage = priorMessages.length === 0;
        setConversations((prev) =>
          prev.map((conv) => {
            if (conv.id !== targetConversationId) return conv;
            return {
              ...conv,
              title: isFirstUserMessage ? deriveTitleFromMessage(displayPrompt) : conv.title,
              updatedAt: now,
              messages: [...conv.messages, userMessage, assistantMessage],
            };
          })
        );
      }

      if (intent.kind === 'image') {
        await runImageTurn({
          conversationId: targetConversationId,
          prompt: displayPrompt,
          assistantMsgId: assistantMessage.id,
          aspectRatio: aspectRatio ?? '1:1',
          sourceImage: inlineSourceImage,
        });
        return;
      }

      await runGeminiTurn({
        conversationId: targetConversationId,
        userPrompt: displayPrompt,
        history: priorMessages,
        assistantMsgId: assistantMessage.id,
        attachments,
        turnMode: intent.mode,
      });
    },
    [runGeminiTurn, runImageTurn]
  );

  const handleRenameConversation = useCallback((id: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    setConversations((prev) =>
      prev.map((conv) =>
        conv.id === id ? { ...conv, title: trimmed, updatedAt: Date.now() } : conv
      )
    );
  }, []);

  const handleEditMessage = useCallback(
    async (messageId: string, newContent: string, regenerateAfterSave: boolean) => {
      const currentActiveId = activeIdRef.current;
      const currentConv = conversationsRef.current.find((c) => c.id === currentActiveId);
      if (!currentConv || isGeneratingRef.current) return;

      const msgIndex = currentConv.messages.findIndex((m) => m.id === messageId);
      if (msgIndex === -1) return;

      const targetMsg = currentConv.messages[msgIndex];
      const now = Date.now();

      if (!regenerateAfterSave || targetMsg.role !== 'user') {
        setConversations((prev) =>
          prev.map((conv) => {
            if (conv.id !== currentConv.id) return conv;
            return {
              ...conv,
              updatedAt: now,
              messages: conv.messages.map((m) =>
                m.id === messageId ? { ...m, content: newContent, updatedAt: now } : m
              ),
            };
          })
        );
        return;
      }

      const historyBefore = currentConv.messages.slice(0, msgIndex);
      const prevAssistant = currentConv.messages[msgIndex + 1];
      const intent = resolveRequestIntent(
        newContent,
        prevAssistant?.mode === 'image' ? 'image' : modeRef.current,
        historyBefore,
        Boolean(targetMsg.attachments?.length)
      );

      let inlineSourceImage = intent.sourceImage;
      if (intent.kind === 'image' && !inlineSourceImage && targetMsg.attachments?.length) {
        const uploadedImg = targetMsg.attachments.find((a) => a.kind === 'image' && a.dataBase64);
        if (uploadedImg?.dataBase64) {
          inlineSourceImage = {
            dataBase64: uploadedImg.dataBase64,
            mimeType: uploadedImg.mimeType,
          };
        }
      }

      const updatedUserMsg: ChatMessage = {
        ...targetMsg,
        content: newContent,
        updatedAt: now,
      };
      const newAssistantMsg: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content: '',
        mode: intent.mode,
        createdAt: now + 1,
      };

      setConversations((prev) =>
        prev.map((conv) => {
          if (conv.id !== currentConv.id) return conv;
          return {
            ...conv,
            updatedAt: now,
            messages: [...historyBefore, updatedUserMsg, newAssistantMsg],
          };
        })
      );

      if (intent.kind === 'image') {
        const prevAspect = prevAssistant?.generatedImages?.[0]?.aspectRatio ?? '1:1';
        await runImageTurn({
          conversationId: currentConv.id,
          prompt: newContent,
          assistantMsgId: newAssistantMsg.id,
          aspectRatio: prevAspect,
          sourceImage: inlineSourceImage,
        });
        return;
      }

      await runGeminiTurn({
        conversationId: currentConv.id,
        userPrompt: newContent,
        history: historyBefore,
        assistantMsgId: newAssistantMsg.id,
        attachments: targetMsg.attachments,
        turnMode: intent.mode,
      });
    },
    [runGeminiTurn, runImageTurn]
  );

  const handleRegenerateAssistant = useCallback(
    async (assistantMsgId: string) => {
      const currentActiveId = activeIdRef.current;
      const currentConv = conversationsRef.current.find((c) => c.id === currentActiveId);
      if (!currentConv || isGeneratingRef.current) return;

      const msgIndex = currentConv.messages.findIndex((m) => m.id === assistantMsgId);
      if (msgIndex === -1) return;

      let userIndex = -1;
      for (let i = msgIndex - 1; i >= 0; i--) {
        if (currentConv.messages[i].role === 'user') {
          userIndex = i;
          break;
        }
      }
      if (userIndex === -1) return;

      const targetAssistantMsg = currentConv.messages[msgIndex];
      const userMsg = currentConv.messages[userIndex];
      const historyBeforeUser = currentConv.messages.slice(0, userIndex);
      const intent = resolveRequestIntent(
        userMsg.content,
        targetAssistantMsg.mode === 'image' ? 'image' : modeRef.current,
        historyBeforeUser,
        Boolean(userMsg.attachments?.length)
      );

      const now = Date.now();
      const freshAssistantMsg: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content: '',
        mode: intent.mode,
        createdAt: now,
      };

      setConversations((prev) =>
        prev.map((conv) => {
          if (conv.id !== currentConv.id) return conv;
          return {
            ...conv,
            updatedAt: now,
            messages: [...currentConv.messages.slice(0, userIndex + 1), freshAssistantMsg],
          };
        })
      );

      if (intent.kind === 'image') {
        const prevAspect = targetAssistantMsg.generatedImages?.[0]?.aspectRatio ?? '1:1';
        await runImageTurn({
          conversationId: currentConv.id,
          prompt: userMsg.content,
          assistantMsgId: freshAssistantMsg.id,
          aspectRatio: prevAspect,
          sourceImage: intent.sourceImage,
        });
        return;
      }

      await runGeminiTurn({
        conversationId: currentConv.id,
        userPrompt: userMsg.content,
        history: historyBeforeUser,
        assistantMsgId: freshAssistantMsg.id,
        attachments: userMsg.attachments,
        turnMode: intent.mode,
      });
    },
    [runGeminiTurn, runImageTurn]
  );

  const handleCreateSvgFallback = useCallback(
    async (assistantMsgId: string) => {
      const currentActiveId = activeIdRef.current;
      const currentConv = conversationsRef.current.find((c) => c.id === currentActiveId);
      if (!currentConv || isGeneratingRef.current) return;

      const msgIndex = currentConv.messages.findIndex((m) => m.id === assistantMsgId);
      if (msgIndex === -1) return;

      let userIndex = -1;
      for (let i = msgIndex - 1; i >= 0; i--) {
        if (currentConv.messages[i].role === 'user') {
          userIndex = i;
          break;
        }
      }
      if (userIndex === -1) return;

      const userMsg = currentConv.messages[userIndex];
      const historyBeforeUser = currentConv.messages.slice(0, userIndex);
      const now = Date.now();
      const freshAssistantMsg: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content: '',
        mode: 'fast',
        createdAt: now,
      };

      setConversations((prev) =>
        prev.map((conv) => {
          if (conv.id !== currentConv.id) return conv;
          return {
            ...conv,
            updatedAt: now,
            messages: [...currentConv.messages.slice(0, userIndex + 1), freshAssistantMsg],
          };
        })
      );

      await runGeminiTurn({
        conversationId: currentConv.id,
        userPrompt: `Create a clean, detailed SVG vector illustration inside a \`\`\`svg code block for: ${userMsg.content}`,
        history: historyBeforeUser,
        assistantMsgId: freshAssistantMsg.id,
        turnMode: 'fast',
      });
    },
    [runGeminiTurn]
  );

  const handleDeleteMessage = useCallback((messageId: string) => {
    const currentActiveId = activeIdRef.current;
    if (!currentActiveId || isGeneratingRef.current) return;
    setConversations((prev) =>
      prev.map((conv) => {
        if (conv.id !== currentActiveId) return conv;
        return {
          ...conv,
          updatedAt: Date.now(),
          messages: conv.messages.filter((m) => m.id !== messageId),
        };
      })
    );
  }, []);

  const handleConfirmDelete = useCallback(() => {
    if (!deleteTarget) return;

    if (deleteTarget.kind === 'all') {
      if (isGeneratingRef.current) {
        handleStopGenerating();
      }
      setConversations([]);
      setActiveId(null);
      setDeleteTarget(null);
      return;
    }

    const targetId = deleteTarget.conversation.id;
    if (streamingConvIdRef.current === targetId) {
      handleStopGenerating();
    }

    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== targetId);
      if (activeIdRef.current === targetId) {
        setActiveId(next[0]?.id ?? null);
      }
      return next;
    });
    setDeleteTarget(null);
  }, [deleteTarget, handleStopGenerating]);

  const handleCloseMobileSidebar = useCallback(() => setIsMobileSidebarOpen(false), []);

  const handleSelectConversation = useCallback(
    (id: string) => {
      if (isGeneratingRef.current && streamingConvIdRef.current !== id) {
        handleStopGenerating();
      }
      setActiveId(id);
    },
    [handleStopGenerating]
  );

  const handleRequestDeleteConversation = useCallback((conversation: Conversation) => {
    setDeleteTarget({ kind: 'single', conversation });
  }, []);

  const handleRequestClearAll = useCallback(() => {
    setDeleteTarget({ kind: 'all' });
  }, []);

  const handleAddMemory = useCallback((content: string) => {
    setMemories((prev) => [
      { id: createId(), content, createdAt: Date.now() },
      ...prev,
    ].slice(0, 15));
  }, []);

  const handleDeleteMemory = useCallback((id: string) => {
    setMemories((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const handleClearMemories = useCallback(() => {
    setMemories([]);
  }, []);

  const handleExportMarkdown = useCallback(() => {
    if (!activeConversation) return;
    const md = exportConversationMarkdown(activeConversation);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const safeName = activeConversation.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeName || 'lumen-chat'}.md`;
    link.click();
    URL.revokeObjectURL(url);
  }, [activeConversation]);

  const lastAssistantId = useMemo(() => {
    if (!activeConversation) return null;
    for (let i = activeConversation.messages.length - 1; i >= 0; i--) {
      if (activeConversation.messages[i].role === 'assistant') {
        return activeConversation.messages[i].id;
      }
    }
    return null;
  }, [activeConversation]);

  const isGenerating = streamingMsgId !== null;

  const commitHeaderRename = () => {
    if (activeConversation && headerDraftTitle.trim()) {
      handleRenameConversation(activeConversation.id, headerDraftTitle);
    }
    setIsHeaderRenaming(false);
  };

  const handleComposerFocus = useCallback(() => {
    if (!shouldAutoScrollRef.current) return;
    window.setTimeout(() => {
      scrollToBottom('smooth');
    }, 180);
  }, [scrollToBottom]);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        isMobileOpen={isMobileSidebarOpen}
        isDesktopCollapsed={isDesktopSidebarCollapsed}
        onCloseMobile={handleCloseMobileSidebar}
        onSelectConversation={handleSelectConversation}
        onNewChat={handleNewChat}
        onRenameConversation={handleRenameConversation}
        onRequestDeleteConversation={handleRequestDeleteConversation}
        onRequestClearAll={handleRequestClearAll}
        onOpenMemory={() => setIsMemoryOpen(true)}
        memoryCount={memories.length}
      />

      {/* Main Workspace */}
      <div className="flex min-w-0 flex-1 flex-col overflow-x-hidden">
        {/* Top Header */}
        <header className="flex h-14 sm:h-16 shrink-0 items-center justify-between gap-2 sm:gap-4 border-b border-slate-200 bg-white px-3 sm:px-6 dark:border-slate-800 dark:bg-slate-950">
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-2.5">
            {/* Mobile Drawer Trigger */}
            <button
              type="button"
              onClick={() => setIsMobileSidebarOpen(true)}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 lg:hidden dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              aria-label="Open conversation history"
            >
              <Menu className="h-5 w-5" />
            </button>

            {/* Desktop Collapse Toggle */}
            <button
              type="button"
              onClick={() => setIsDesktopSidebarCollapsed((prev) => !prev)}
              className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 lg:flex dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              aria-label={isDesktopSidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
              title={isDesktopSidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            >
              {isDesktopSidebarCollapsed ? (
                <PanelLeftOpen className="h-4.5 w-4.5" />
              ) : (
                <PanelLeftClose className="h-4.5 w-4.5" />
              )}
            </button>

            {/* Active Conversation Title / Inline Rename */}
            {activeConversation ? (
              isHeaderRenaming ? (
                <div className="flex min-w-0 flex-1 max-w-md items-center gap-1.5 rounded-lg border border-blue-500 bg-slate-50 px-2.5 py-1 dark:bg-slate-900">
                  <input
                    ref={headerInputRef}
                    type="text"
                    value={headerDraftTitle}
                    onChange={(e) => setHeaderDraftTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitHeaderRename();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setIsHeaderRenaming(false);
                      }
                    }}
                    aria-label="Rename active conversation"
                    className="min-w-0 flex-1 bg-transparent text-base sm:text-sm font-semibold text-slate-900 focus:outline-none dark:text-slate-100"
                  />
                  <button
                    type="button"
                    onClick={commitHeaderRename}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-blue-600 hover:bg-blue-100 dark:text-blue-400 dark:hover:bg-blue-950"
                    aria-label="Save conversation name"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsHeaderRenaming(false)}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800"
                    aria-label="Cancel renaming"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex min-w-0 items-center gap-2">
                  <h1 className="truncate font-display text-sm font-semibold text-slate-900 sm:text-base dark:text-slate-100">
                    {activeConversation.title}
                  </h1>
                  <button
                    type="button"
                    onClick={() => {
                      setHeaderDraftTitle(activeConversation.title);
                      setIsHeaderRenaming(true);
                    }}
                    className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 sm:flex dark:hover:bg-slate-800 dark:hover:text-slate-200"
                    aria-label="Rename current conversation"
                    title="Rename conversation"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <span className="hidden text-xs text-slate-400 tabular-nums md:inline dark:text-slate-500">
                    <span aria-hidden="true">·</span>{' '}
                    {activeConversation.messages.length}{' '}
                    {activeConversation.messages.length === 1 ? 'message' : 'messages'}
                  </span>
                </div>
              )
            ) : (
              <h1 className="font-display text-sm font-semibold text-slate-900 sm:text-base dark:text-slate-100 whitespace-nowrap">
                Lumen Assistant
              </h1>
            )}
          </div>

          {/* Right Header Controls */}
          <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
            {activeConversation && activeConversation.messages.length > 0 && (
              <button
                type="button"
                onClick={handleExportMarkdown}
                className="flex h-11 w-11 sm:h-10 sm:w-10 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                aria-label="Export conversation as Markdown"
                title="Export Markdown"
              >
                <Download className="h-4.5 w-4.5" />
              </button>
            )}

            <button
              type="button"
              onClick={() => setIsMemoryOpen(true)}
              className="relative flex h-11 w-11 sm:h-10 sm:w-10 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              aria-label="Open persistent memory"
              title="Persistent Memory"
            >
              <Brain className="h-4.5 w-4.5" />
              {memories.length > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute top-2 right-2 h-2 w-2 rounded-full bg-blue-600 dark:bg-blue-400"
                />
              )}
            </button>

            <button
              type="button"
              onClick={handleNewChat}
              className="flex h-11 w-11 sm:h-10 sm:w-10 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              aria-label="Start new chat"
              title="New Chat"
            >
              <SquarePen className="h-4.5 w-4.5" />
            </button>

            <button
              type="button"
              onClick={() => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'))}
              className="flex h-11 w-11 sm:h-10 sm:w-10 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              aria-label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
              title={theme === 'light' ? 'Dark mode' : 'Light mode'}
            >
              {theme === 'light' ? (
                <Moon className="h-4.5 w-4.5" />
              ) : (
                <Sun className="h-4.5 w-4.5" />
              )}
            </button>
          </div>
        </header>

        {/* Storage Quota Warning Banner */}
        {storageError && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900 sm:px-6 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <span>{storageError}</span>
            </div>
            <button
              type="button"
              onClick={() => setStorageError(null)}
              className="rounded p-1 hover:bg-amber-200/60 dark:hover:bg-amber-900/60"
              aria-label="Dismiss storage warning"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Chat Viewport */}
        <main className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="flex flex-1 flex-col overflow-y-auto overflow-x-hidden px-3.5 py-4 sm:px-6 sm:py-6"
          >
            {!activeConversation || activeConversation.messages.length === 0 ? (
              <div className="mx-auto my-auto flex w-full max-w-2xl flex-col items-center py-4 text-center sm:py-8">
                <div className="flex h-11 w-11 sm:h-12 sm:w-12 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-sm">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    className="h-5 w-5 sm:h-6 sm:w-6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2L12 3z" />
                  </svg>
                </div>

                <h2 className="mt-4 sm:mt-5 font-display text-xl font-semibold tracking-tight text-slate-900 sm:text-3xl dark:text-white text-balance">
                  How can I help you today?
                </h2>
                <p className="mt-2 max-w-lg text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                  Switch between Fast, Deep Think, and Web Search modes. Attach images, PDFs, or code files, use voice input, and chat naturally in English, اردو, or Roman Urdu.
                </p>

                <div className="mt-6 sm:mt-8 grid w-full grid-cols-1 gap-2.5 sm:grid-cols-2 sm:gap-3">
                  {STARTER_PROMPTS.map((item) => (
                    <button
                      key={item.title}
                      type="button"
                      onClick={() => {
                        if (item.mode) setMode(item.mode);
                        void handleSendMessage(item.prompt, undefined, item.mode);
                      }}
                      disabled={isGenerating}
                      className="group min-h-[44px] rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 sm:p-4 text-left transition-colors hover:border-blue-300 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900/60 dark:hover:border-blue-700 dark:hover:bg-slate-900"
                    >
                      <div className="text-sm font-medium text-slate-900 group-hover:text-blue-600 dark:text-slate-100 dark:group-hover:text-blue-400">
                        {item.title}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                        {item.subtitle}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mx-auto w-full max-w-3xl space-y-5 sm:space-y-6 pb-4">
                {activeConversation.messages.map((msg) => (
                  <MessageItem
                    key={msg.id}
                    message={msg}
                    isStreaming={streamingMsgId === msg.id}
                    isLastAssistant={msg.id === lastAssistantId}
                    disabled={isGenerating}
                    onEditMessage={handleEditMessage}
                    onDeleteMessage={handleDeleteMessage}
                    onRegenerate={handleRegenerateAssistant}
                    onCreateSvgFallback={handleCreateSvgFallback}
                  />
                ))}
                <div ref={messagesEndRef} className="h-1" />
              </div>
            )}
          </div>

          {/* Scroll-to-latest button */}
          {showScrollButton && (
            <button
              type="button"
              onClick={() => {
                shouldAutoScrollRef.current = true;
                scrollToBottom('smooth');
                setShowScrollButton(false);
              }}
              className="absolute right-4 sm:right-6 bottom-3 sm:bottom-4 z-10 flex h-10 w-10 sm:h-9 sm:w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-md transition-colors hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
              aria-label="Scroll to latest message"
              title="Scroll to bottom"
            >
              <ArrowDown className="h-4 w-4" />
            </button>
          )}
        </main>

        {/* Composer */}
        <Composer
          resetKey={`${activeId ?? 'new'}-${composerResetNonce}`}
          isGenerating={isGenerating}
          mode={mode}
          onModeChange={setMode}
          onSend={handleSendMessage}
          onStop={handleStopGenerating}
          onInputFocus={handleComposerFocus}
        />
      </div>

      {/* Persistent Memory Dialog */}
      <MemoryModal
        isOpen={isMemoryOpen}
        memories={memories}
        onAddMemory={handleAddMemory}
        onDeleteMemory={handleDeleteMemory}
        onClearMemories={handleClearMemories}
        onClose={() => setIsMemoryOpen(false)}
      />

      {/* Delete Confirmation Dialog */}
      <ConfirmModal
        isOpen={deleteTarget !== null}
        title={
          deleteTarget?.kind === 'all'
            ? 'Clear all chat history?'
            : 'Delete conversation?'
        }
        description={
          deleteTarget?.kind === 'all'
            ? `This will permanently remove all ${conversations.length} saved conversations from your browser storage. This action cannot be undone.`
            : deleteTarget?.kind === 'single'
              ? `This will permanently delete "${deleteTarget.conversation.title}" (${deleteTarget.conversation.messages.length} ${
                  deleteTarget.conversation.messages.length === 1 ? 'message' : 'messages'
                }) from your browser storage.`
              : ''
        }
        confirmLabel={deleteTarget?.kind === 'all' ? 'Clear All' : 'Delete'}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
