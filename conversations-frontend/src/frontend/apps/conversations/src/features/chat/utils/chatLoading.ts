import type { Message } from '@ai-sdk/ui-utils';

type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error';

const assistantHasVisibleProgress = (message: Message): boolean => {
  if (message.content?.trim()) {
    return true;
  }

  return Boolean(
    message.parts?.some((part) => {
      if (part.type === 'text') {
        return Boolean(part.text?.trim());
      }
      return part.type === 'tool-invocation';
    }),
  );
};

/**
 * The HTTP stream can be open for several seconds before its first visible
 * event. Keep the thinking indicator until the response to the latest user
 * message actually contains text or a visible tool invocation. A source event
 * alone does not count because source controls stay hidden during streaming.
 */
export const isAwaitingFirstAssistantOutput = (
  messages: Message[],
  status: ChatStatus,
): boolean => {
  if (status !== 'submitted' && status !== 'streaming') {
    return false;
  }

  const lastUserIndex = messages.findLastIndex(
    (message) => message.role === 'user',
  );
  if (lastUserIndex === -1) {
    return false;
  }

  const currentAssistant = messages
    .slice(lastUserIndex + 1)
    .find((message) => message.role === 'assistant');

  return !currentAssistant || !assistantHasVisibleProgress(currentAssistant);
};
