import type { AssistantMode, ChatMessage } from '../types/chat';

export interface ResolvedIntent {
  kind: 'chat' | 'image';
  mode: AssistantMode;
  isEditFollowUp: boolean;
  sourceImage?: {
    dataBase64: string;
    mimeType: string;
  };
}

const QUESTION_OR_CODE_GUARD =
  /\b(explain|what is|how does|how to|why does|write code|react|typescript|javascript|python|html|css|svg|sql|prompt for|describe|analyze|read this|summarize|roadmap|flowchart|diagram|wireframe|table|markdown|essay|story|function|component|script)\b/i;

const EXPLICIT_IMAGE_GEN_REGEX =
  /(?:\b(?:generate|create|draw|paint|sketch|render|make|design)\s+(?:an?\s+|some\s+)?(?:high[- ]quality\s+|realistic\s+|detailed\s+|3d\s+|digital\s+|anime\s+|cartoon\s+)?(?:image|picture|photo|photograph|illustration|artwork|painting|portrait|wallpaper|poster|drawing|logo|icon|avatar)\b|^\s*(?:draw|paint|sketch|render)\s+(?:an?\s+|the\s+)?[a-z0-9]|^\s*(?:an?\s+)?(?:high[- ]quality\s+|realistic\s+|detailed\s+|3d\s+|digital\s+|anime\s+|cartoon\s+)?(?:image|picture|photo|photograph|illustration|artwork|painting|portrait|wallpaper|poster|sketch|drawing)\s+(?:of|about|showing|with|featuring)\b)/i;

const IMAGE_EDIT_FOLLOWUP_REGEX =
  /\b(?:make\s+(?:that|this|the)\s+(?:image|picture|photo|it)|edit\s+(?:that|this|the)\s+(?:image|picture|photo)|change\s+(?:the\s+)?(?:background|lighting|sky|color|style)|make\s+it\s+(?:more\s+)?(?:realistic|cinematic|brighter|darker|cartoon|anime|colorful)|add\s+.+\s+to\s+(?:the|that|this)\s+(?:image|picture|photo))\b/i;

function findLatestImageInHistory(
  history: ChatMessage[]
): { dataBase64: string; mimeType: string } | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.generatedImages && msg.generatedImages.length > 0) {
      const latest = msg.generatedImages[msg.generatedImages.length - 1];
      const base64 = latest.dataUrl.split(',')[1];
      if (base64) {
        return { dataBase64: base64, mimeType: latest.mimeType };
      }
    }
    if (msg.attachments && msg.attachments.length > 0) {
      for (let j = msg.attachments.length - 1; j >= 0; j--) {
        const att = msg.attachments[j];
        if (att.kind === 'image') {
          const raw = att.dataBase64 || att.previewUrl?.split(',')[1];
          if (raw) {
            return { dataBase64: raw, mimeType: att.mimeType };
          }
        }
      }
    }
  }
  return undefined;
}

export function resolveRequestIntent(
  prompt: string,
  selectedMode: AssistantMode,
  history: ChatMessage[],
  hasCurrentAttachments: boolean
): ResolvedIntent {
  if (selectedMode === 'image') {
    const latestImage = findLatestImageInHistory(history);
    const wantsEdit = Boolean(latestImage) && IMAGE_EDIT_FOLLOWUP_REGEX.test(prompt);
    return {
      kind: 'image',
      mode: 'image',
      isEditFollowUp: wantsEdit,
      sourceImage: wantsEdit ? latestImage : undefined,
    };
  }

  if (hasCurrentAttachments || QUESTION_OR_CODE_GUARD.test(prompt)) {
    return { kind: 'chat', mode: selectedMode, isEditFollowUp: false };
  }

  const latestImage = findLatestImageInHistory(history);
  if (latestImage && IMAGE_EDIT_FOLLOWUP_REGEX.test(prompt)) {
    return {
      kind: 'image',
      mode: 'image',
      isEditFollowUp: true,
      sourceImage: latestImage,
    };
  }

  if (EXPLICIT_IMAGE_GEN_REGEX.test(prompt)) {
    return { kind: 'image', mode: 'image', isEditFollowUp: false };
  }

  return { kind: 'chat', mode: selectedMode, isEditFollowUp: false };
}
