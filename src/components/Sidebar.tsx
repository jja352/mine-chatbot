import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  Brain,
  Check,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { Conversation } from '../types/chat';
import { formatRelativeTime } from '../utils/storage';

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  isMobileOpen: boolean;
  isDesktopCollapsed: boolean;
  onCloseMobile: () => void;
  onSelectConversation: (id: string) => void;
  onNewChat: () => void;
  onRenameConversation: (id: string, newTitle: string) => void;
  onRequestDeleteConversation: (conversation: Conversation) => void;
  onRequestClearAll: () => void;
  onOpenMemory: () => void;
  memoryCount: number;
}

function getDateBucketLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const sevenDaysAgo = startOfToday - 7 * 24 * 60 * 60 * 1000;

  const ts = date.getTime();
  if (ts >= startOfToday) return 'Today';
  if (ts >= startOfYesterday) return 'Yesterday';
  if (ts >= sevenDaysAgo) return 'Previous 7 Days';
  return 'Older';
}

export const Sidebar = memo(function Sidebar({
  conversations,
  activeId,
  isMobileOpen,
  isDesktopCollapsed,
  onCloseMobile,
  onSelectConversation,
  onNewChat,
  onRenameConversation,
  onRequestDeleteConversation,
  onRequestClearAll,
  onOpenMemory,
  memoryCount,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredConversations = useMemo(() => {
    if (!normalizedQuery) return conversations;
    return conversations.filter(
      (conv) =>
        conv.title.toLowerCase().includes(normalizedQuery) ||
        conv.messages.some((m) => m.content.toLowerCase().includes(normalizedQuery))
    );
  }, [conversations, normalizedQuery]);

  const groupedConversations = useMemo(() => {
    const groups: { label: string; items: Conversation[] }[] = [];
    const bucketOrder = ['Today', 'Yesterday', 'Previous 7 Days', 'Older'];
    const map = new Map<string, Conversation[]>();

    for (const conv of filteredConversations) {
      const label = getDateBucketLabel(conv.updatedAt);
      const list = map.get(label) ?? [];
      list.push(conv);
      map.set(label, list);
    }

    for (const label of bucketOrder) {
      const items = map.get(label);
      if (items && items.length > 0) {
        groups.push({ label, items });
      }
    }

    return groups;
  }, [filteredConversations]);

  const startEditing = (conv: Conversation) => {
    setEditingId(conv.id);
    setDraftTitle(conv.title);
  };

  const commitEditing = (id: string) => {
    const trimmed = draftTitle.trim();
    if (trimmed) {
      onRenameConversation(id, trimmed);
    }
    setEditingId(null);
    setDraftTitle('');
  };

  const cancelEditing = () => {
    setEditingId(null);
    setDraftTitle('');
  };

  const renderConversationItem = (conv: Conversation) => {
    const isActive = conv.id === activeId;
    const isEditing = editingId === conv.id;

    return (
      <li key={conv.id}>
        {isEditing ? (
          <div className="flex items-center gap-1.5 rounded-xl border border-blue-500 bg-white px-2.5 py-2 dark:bg-slate-950">
            <input
              ref={editInputRef}
              type="text"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitEditing(conv.id);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelEditing();
                }
              }}
              aria-label="Rename conversation"
              className="min-w-0 flex-1 bg-transparent text-base sm:text-sm text-slate-900 focus:outline-none dark:text-slate-100"
            />
            <button
              type="button"
              onClick={() => commitEditing(conv.id)}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/60"
              aria-label="Save title"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={cancelEditing}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              aria-label="Cancel rename"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div
            className={`group relative flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 transition-colors ${
              isActive
                ? 'border border-slate-200 bg-white shadow-xs dark:border-slate-700/80 dark:bg-slate-800/90'
                : 'border border-transparent hover:bg-slate-200/60 dark:hover:bg-slate-800/50'
            }`}
          >
            <button
              type="button"
              onClick={() => {
                onSelectConversation(conv.id);
                onCloseMobile();
              }}
              onDoubleClick={() => startEditing(conv)}
              className="min-w-0 flex-1 text-left focus-visible:outline-none"
            >
              <div
                className={`truncate text-sm font-medium ${
                  isActive
                    ? 'text-slate-900 dark:text-white'
                    : 'text-slate-700 dark:text-slate-200'
                }`}
              >
                {conv.title}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500 tabular-nums dark:text-slate-400">
                <span>
                  {conv.messages.length}{' '}
                  {conv.messages.length === 1 ? 'msg' : 'msgs'}
                </span>
                <span aria-hidden="true">·</span>
                <span>{formatRelativeTime(conv.updatedAt)}</span>
              </div>
            </button>

            <div
              className={`flex shrink-0 items-center gap-0.5 transition-opacity ${
                isActive
                  ? 'opacity-100'
                  : 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100'
              }`}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  startEditing(conv);
                }}
                className="flex h-10 w-10 sm:h-8 sm:w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-200/80 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-slate-700 dark:hover:text-slate-100"
                aria-label={`Rename ${conv.title}`}
                title="Rename conversation"
              >
                <Pencil className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRequestDeleteConversation(conv);
                }}
                className="flex h-10 w-10 sm:h-8 sm:w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:hover:bg-red-950/60 dark:hover:text-red-400"
                aria-label={`Delete ${conv.title}`}
                title="Delete conversation"
              >
                <Trash2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
              </button>
            </div>
          </div>
        )}
      </li>
    );
  };

  const sidebarContent = (
    <div className="flex h-full flex-col bg-slate-50 text-slate-900 dark:bg-slate-900 dark:text-slate-100">
      {/* Brand Header */}
      <div className="flex h-16 shrink-0 items-center justify-between border-b border-slate-200 px-4 dark:border-slate-800">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="h-4 w-4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2L12 3z" />
            </svg>
          </div>
          <span className="font-display text-base font-semibold tracking-tight whitespace-nowrap truncate">
            Lumen Chat
          </span>
        </div>

        <button
          type="button"
          onClick={onCloseMobile}
          className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 lg:hidden dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          aria-label="Close sidebar"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Primary Action + Search */}
      <div className="space-y-3 p-3.5 border-b border-slate-200/80 dark:border-slate-800/80">
        <button
          type="button"
          onClick={() => {
            onNewChat();
            onCloseMobile();
          }}
          className="flex min-h-[42px] w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 whitespace-nowrap dark:focus-visible:ring-offset-slate-900"
        >
          <Plus className="h-4 w-4 shrink-0" />
          <span>New Chat</span>
        </button>

        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search conversations..."
            aria-label="Search conversations"
            className="w-full rounded-lg border border-slate-200 bg-white py-2 pr-8 pl-9 text-base sm:text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700/80 dark:bg-slate-950/60 dark:text-slate-100 dark:placeholder:text-slate-500"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Conversation List */}
      <div className="flex-1 overflow-y-auto px-2.5 py-3">
        {conversations.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <MessageSquare className="mx-auto h-7 w-7 text-slate-300 dark:text-slate-600" />
            <p className="mt-2.5 text-sm font-medium text-slate-600 dark:text-slate-400">
              No saved chats yet
            </p>
            <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-500">
              Start a conversation and your history will stay saved in this browser.
            </p>
          </div>
        ) : groupedConversations.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              No matches for “{searchQuery}”
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {groupedConversations.map((group) => (
              <div key={group.label}>
                <h2 className="px-3 pb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                  {group.label}
                </h2>
                <ul className="space-y-1" role="list" aria-label={`${group.label} conversations`}>
                  {group.items.map(renderConversationItem)}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer Memory & Clear Actions */}
      <div className="shrink-0 space-y-1.5 border-t border-slate-200 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-3 dark:border-slate-800">
        <button
          type="button"
          onClick={() => {
            onOpenMemory();
            onCloseMobile();
          }}
          className="flex min-h-[42px] sm:min-h-[38px] w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-200/70 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 whitespace-nowrap dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
        >
          <span className="flex items-center gap-2">
            <Brain className="h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
            <span>Memory</span>
          </span>
          {memoryCount > 0 && (
            <span className="text-[11px] font-semibold text-blue-600 tabular-nums dark:text-blue-400">
              {memoryCount}
            </span>
          )}
        </button>

        {conversations.length > 0 && (
          <button
            type="button"
            onClick={onRequestClearAll}
            className="flex min-h-[42px] sm:min-h-[38px] w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-slate-600 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 whitespace-nowrap dark:text-slate-400 dark:hover:bg-red-950/50 dark:hover:text-red-400"
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" />
            <span>Clear All History</span>
          </button>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Sidebar */}
      <aside
        className={`hidden lg:block shrink-0 border-r border-slate-200 transition-[width] duration-200 ease-out overflow-hidden dark:border-slate-800 ${
          isDesktopCollapsed ? 'w-0 border-r-0' : 'w-[272px]'
        }`}
        aria-label="Conversations sidebar"
      >
        <div className="h-full w-[272px]">{sidebarContent}</div>
      </aside>

      {/* Mobile Drawer */}
      {isMobileOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div
            className="fixed inset-0 bg-slate-950/50 backdrop-blur-[1px]"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <aside
            className="relative z-10 h-full w-[280px] max-w-[85vw] border-r border-slate-200 shadow-2xl dark:border-slate-800"
            aria-label="Mobile conversations drawer"
          >
            {sidebarContent}
          </aside>
        </div>
      )}
    </>
  );
});
