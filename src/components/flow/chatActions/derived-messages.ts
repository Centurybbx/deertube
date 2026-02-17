import type { ChatMessage } from "@/types/chat";
import type { DeertubeUIMessage } from "@/modules/ai/tools";
import {
  buildAgentToolStatusByToolCall,
  buildDeepSearchEvents,
  buildSubagentEvents,
  mapUiMessagesToChat,
  mergeDeepSearchEvents,
  mergeGraphEvents,
  mergePersistedAgentEvents,
  mergeSubagentEvents,
} from "./message-events";

interface BuildDerivedMessagesOptions {
  messages: DeertubeUIMessage[];
  status: string;
  error: Error | undefined;
  fallbackCreatedAtById: Map<string, string>;
  graphEventMessages: ChatMessage[];
  asyncSubagentEventMessages: ChatMessage[];
  asyncDeepSearchEventMessages: ChatMessage[];
  persistedSubagentEvents: ChatMessage[];
  persistedDeepSearchEvents: ChatMessage[];
}

export const buildDerivedMessages = ({
  messages,
  status,
  error,
  fallbackCreatedAtById,
  graphEventMessages,
  asyncSubagentEventMessages,
  asyncDeepSearchEventMessages,
  persistedSubagentEvents,
  persistedDeepSearchEvents,
}: BuildDerivedMessagesOptions): ChatMessage[] => {
  const mapped = mapUiMessagesToChat(
    messages,
    status,
    error,
    fallbackCreatedAtById,
  );
  const withGraphEvents = graphEventMessages.length
    ? mergeGraphEvents(mapped, graphEventMessages)
    : mapped;
  const runtimeDeepSearchEvents = mergePersistedAgentEvents(
    asyncDeepSearchEventMessages,
    buildDeepSearchEvents(messages, status),
  );
  const deepSearchEvents = mergePersistedAgentEvents(
    persistedDeepSearchEvents,
    runtimeDeepSearchEvents,
  );
  const deepSearchStatusByToolCall = buildAgentToolStatusByToolCall(
    deepSearchEvents,
    "deepsearch-event",
  );
  const subagentEvents = mergePersistedAgentEvents(
    persistedSubagentEvents,
    mergePersistedAgentEvents(
      asyncSubagentEventMessages,
      buildSubagentEvents(messages, status, deepSearchStatusByToolCall),
    ),
  );
  const withSubagentEvents = subagentEvents.length
    ? mergeSubagentEvents(withGraphEvents, subagentEvents)
    : withGraphEvents;
  if (!deepSearchEvents.length) {
    return withSubagentEvents;
  }
  return mergeDeepSearchEvents(withSubagentEvents, deepSearchEvents);
};
