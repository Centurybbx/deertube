type RunningJobsByProject = Record<string, Record<string, string[]>>;

const listeners = new Set<() => void>();
const runtimeState: RunningJobsByProject = {};

const notifyListeners = () => {
  listeners.forEach((listener) => {
    listener();
  });
};

const normalizeJobList = (values: string[]): string[] =>
  Array.from(new Set(values.filter((value) => value.trim().length > 0)));

export const startRunningChatJob = (
  projectPath: string,
  chatId: string,
  jobId: string,
) => {
  if (!projectPath || !chatId || !jobId) {
    return;
  }
  const byChat = runtimeState[projectPath] ?? {};
  const jobs = normalizeJobList([...(byChat[chatId] ?? []), jobId]);
  byChat[chatId] = jobs;
  runtimeState[projectPath] = byChat;
  notifyListeners();
};

export const finishRunningChatJob = (
  projectPath: string,
  chatId: string,
  jobId: string,
) => {
  if (!projectPath || !chatId || !jobId) {
    return;
  }
  const byChat = runtimeState[projectPath];
  if (!byChat) {
    return;
  }
  const jobs = (byChat[chatId] ?? []).filter((value) => value !== jobId);
  if (jobs.length === 0) {
    delete byChat[chatId];
  } else {
    byChat[chatId] = jobs;
  }
  if (Object.keys(byChat).length === 0) {
    delete runtimeState[projectPath];
  } else {
    runtimeState[projectPath] = byChat;
  }
  notifyListeners();
};

export const listRunningChatIds = (projectPath: string): Set<string> => {
  const byChat = runtimeState[projectPath] ?? {};
  return new Set(
    Object.entries(byChat)
      .filter(([, jobs]) => Array.isArray(jobs) && jobs.length > 0)
      .map(([chatId]) => chatId),
  );
};

export const subscribeRunningChatJobs = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
