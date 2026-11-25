import { useEffect, useState } from 'react';
import { Brain, Plus, Trash2, X } from 'lucide-react';
import type { MemoryNote } from '../types/chat';

interface MemoryModalProps {
  isOpen: boolean;
  memories: MemoryNote[];
  onAddMemory: (content: string) => void;
  onDeleteMemory: (id: string) => void;
  onClearMemories: () => void;
  onClose: () => void;
}

export function MemoryModal({
  isOpen,
  memories,
  onAddMemory,
  onDeleteMemory,
  onClearMemories,
  onClose,
}: MemoryModalProps) {
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    onAddMemory(trimmed);
    setDraft('');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="memory-modal-title"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85dvh] w-full max-w-lg flex-col rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-950/60 dark:text-blue-400">
              <Brain className="h-4.5 w-4.5" />
            </div>
            <div>
              <h2
                id="memory-modal-title"
                className="text-base font-semibold text-slate-900 dark:text-slate-100"
              >
                Persistent Memory
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Preferences and facts remembered across all conversations
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label="Close memory settings"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <form onSubmit={handleSubmit} className="flex gap-2">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={240}
              placeholder="e.g. I'm a Next.js developer; prefer concise Roman Urdu"
              aria-label="Add persistent memory note"
              className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-base sm:text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-500"
            />
            <button
              type="submit"
              disabled={!draft.trim() || memories.length >= 15}
              className="inline-flex min-h-[42px] shrink-0 items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              <span>Save</span>
            </button>
          </form>

          {memories.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center dark:border-slate-800">
              <p className="text-sm font-medium text-slate-600 dark:text-slate-300">
                No saved memories yet
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Add your role, preferred language (English, Urdu, Roman Urdu), or style preferences so Lumen remembers them in every session.
              </p>
            </div>
          ) : (
            <ul className="space-y-2" role="list" aria-label="Saved memories">
              {memories.map((mem) => (
                <li
                  key={mem.id}
                  className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 dark:border-slate-800 dark:bg-slate-950/60"
                >
                  <p className="text-sm leading-relaxed text-slate-800 dark:text-slate-200">
                    {mem.content}
                  </p>
                  <button
                    type="button"
                    onClick={() => onDeleteMemory(mem.id)}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/60 dark:hover:text-red-400"
                    aria-label="Delete memory"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {memories.length > 0 && (
          <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 dark:border-slate-800">
            <span className="text-xs text-slate-500 tabular-nums dark:text-slate-400">
              {memories.length}/15 notes stored locally
            </span>
            <button
              type="button"
              onClick={onClearMemories}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/50"
            >
              Clear all memories
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
