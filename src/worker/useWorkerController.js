import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { projectWorkApi } from "../api/projectWork.js";
import { workerApi } from "../api/worker.js";
import {
  adaptWorkerBundle,
  buildWorkerActionInput,
  buildWorkerReadInput,
  isWorkerConversationBusy,
  normalizeWorkerConnections,
  normalizeWorkerDefinitions,
  normalizeWorkerTasks,
  unwrapWorkerConversation,
} from "./liveWorkerState.js";
import { workerReducer } from "./workerState.js";

const POLL_INTERVAL_MS = 700;
const MAX_POLL_ATTEMPTS = 180;

function requestId(prefix) {
  return `${prefix}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

async function workerRequest(path, { method = "POST", body, signal } = {}) {
  const response = await fetch(path, {
    method,
    signal,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    const error = new Error("Worker 服务返回了无效响应");
    error.code = "WORKER_RESPONSE_INVALID";
    throw error;
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "Worker 操作失败");
    error.code = payload?.error?.code || "WORKER_REQUEST_FAILED";
    error.status = response.status;
    error.retryable = payload?.error?.retryable === true;
    error.unknownOutcome = payload?.error?.unknown_outcome === true;
    throw error;
  }
  return payload;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function serializeAttachment(attachment) {
  return {
    attachment_id: attachment.id,
    attachment_revision: attachment.revision ?? attachment.contentHash,
  };
}

function connectionMapWithStatus(current, workerId, next) {
  const existing = current[workerId] ?? {};
  const connectorId = next.connectorId ?? existing.connectorId;
  const merged = { ...existing, ...next };
  return {
    ...current,
    [workerId]: merged,
    ...(connectorId ? { [connectorId]: merged } : {}),
  };
}

export function createDraftInvalidationCoordinator() {
  const claims = new Set();
  const keyFor = ({ taskId, draftRevisionId }) => `${taskId}\u0000${draftRevisionId}`;
  return {
    reset(taskId = null) {
      if (!taskId) {
        claims.clear();
        return;
      }
      const prefix = `${taskId}\u0000`;
      for (const key of claims) {
        if (key.startsWith(prefix)) claims.delete(key);
      }
    },
    async invalidateOnce(input, { invalidate, refresh, onError }) {
      if (!input?.taskId || !input?.draftRevisionId) return false;
      const key = keyFor(input);
      if (claims.has(key)) return true;
      claims.add(key);
      try {
        await invalidate();
        await refresh();
        return true;
      } catch (error) {
        claims.delete(key);
        await refresh().catch(() => undefined);
        onError?.(error);
        return false;
      }
    },
  };
}

export function useWorkerController({
  active = false,
  preferredTaskId = "",
  projectOptions = [],
  defaultProviderId = "",
  defaultModelId = "",
  onSelectionChange,
  onError,
} = {}) {
  const [definitions, setDefinitions] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [connections, setConnections] = useState({});
  const [activeWorkerId, setActiveWorkerId] = useState(null);
  const [activeTaskId, setActiveTaskId] = useState(null);
  const [bundle, setBundle] = useState(null);
  const [state, setState] = useState(null);
  const [status, setStatus] = useState("idle");
  const [busyAction, setBusyAction] = useState(null);
  const [error, setError] = useState(null);
  const draftInvalidationCoordinatorRef = useRef(null);
  if (!draftInvalidationCoordinatorRef.current) {
    draftInvalidationCoordinatorRef.current = createDraftInvalidationCoordinator();
  }
  const initializedRef = useRef(false);
  const epochRef = useRef(0);
  const activeTaskIdRef = useRef(null);
  const bundleRef = useRef(null);
  const definitionsRef = useRef([]);
  const connectionsRef = useRef({});
  const projectOptionsRef = useRef(projectOptions);
  const importedSourcesRef = useRef(new Map());
  const pendingAttachmentsRef = useRef(new Map());
  const onErrorRef = useRef(onError);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const unsubscribeRef = useRef(null);
  const subscribedTaskIdRef = useRef(null);
  const subscriptionWasBusyRef = useRef(false);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

  useEffect(() => {
    activeTaskIdRef.current = activeTaskId;
  }, [activeTaskId]);

  const reportError = useCallback((nextError) => {
    setError(nextError);
    onErrorRef.current?.(nextError);
  }, []);

  const renderBundle = useCallback((nextBundle, { preserveLocal = true } = {}) => {
    if (!nextBundle?.task?.id) return null;
    bundleRef.current = nextBundle;
    setBundle(nextBundle);
    const taskId = nextBundle.task.id;
    setState((current) => adaptWorkerBundle(nextBundle, {
      definitions: definitionsRef.current,
      connections: connectionsRef.current,
      projectOptions: projectOptionsRef.current,
      importedSources: importedSourcesRef.current.get(taskId) ?? [],
      pendingAttachments: pendingAttachmentsRef.current.get(taskId) ?? [],
      previousState: preserveLocal ? current : null,
      defaultProviderId,
      defaultModelId,
    }));
    return nextBundle;
  }, [defaultModelId, defaultProviderId]);

  const refreshTask = useCallback(async (taskId, { epoch = epochRef.current } = {}) => {
    const nextBundle = await workerApi.getTask(taskId);
    if (epoch !== epochRef.current || activeTaskIdRef.current !== taskId) return null;
    return renderBundle(nextBundle);
  }, [renderBundle]);

  const pollTask = useCallback(async (taskId, epoch) => {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
      if (epoch !== epochRef.current || activeTaskIdRef.current !== taskId) return;
      const nextBundle = await workerApi.getTask(taskId);
      if (epoch !== epochRef.current || activeTaskIdRef.current !== taskId) return;
      renderBundle(nextBundle);
      if (!isWorkerConversationBusy(nextBundle.conversation)) return;
      await wait(POLL_INTERVAL_MS);
    }
    const timeoutError = new Error("Worker 仍在运行；状态会在下次打开任务时继续恢复");
    timeoutError.code = "WORKER_POLL_TIMEOUT";
    reportError(timeoutError);
  }, [renderBundle, reportError]);

  const startSubscription = useCallback((taskId, nextBundle, epoch) => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    subscribedTaskIdRef.current = null;
    const conversation = unwrapWorkerConversation(nextBundle?.conversation);
    if (!conversation?.id) return false;
    subscriptionWasBusyRef.current = isWorkerConversationBusy(conversation);
    const unsubscribe = projectWorkApi.subscribeConversation({
      conversationId: conversation.id,
      afterSeq: conversation.lastEventSeq ?? 0,
      onConversation: (nextConversation) => {
        if (epoch !== epochRef.current || activeTaskIdRef.current !== taskId) return;
        const wasBusy = subscriptionWasBusyRef.current;
        const nextBusy = isWorkerConversationBusy(nextConversation);
        subscriptionWasBusyRef.current = nextBusy;
        renderBundle({
          ...bundleRef.current,
          conversation: nextConversation,
        });
        if (wasBusy && !nextBusy) {
          refreshTask(taskId, { epoch }).catch(reportError);
        }
      },
      onError: () => {
        if (
          epoch === epochRef.current
          && activeTaskIdRef.current === taskId
          && isWorkerConversationBusy(bundleRef.current?.conversation)
        ) {
          pollTask(taskId, epoch).catch(reportError);
        }
      },
    });
    if (!unsubscribe) return false;
    unsubscribeRef.current = unsubscribe;
    subscribedTaskIdRef.current = taskId;
    return true;
  }, [pollTask, refreshTask, renderBundle, reportError]);

  const selectTask = useCallback(async (taskId, workerId = null) => {
    if (!taskId) return false;
    draftInvalidationCoordinatorRef.current.reset();
    const epoch = epochRef.current + 1;
    epochRef.current = epoch;
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    subscribedTaskIdRef.current = null;
    activeTaskIdRef.current = taskId;
    setActiveTaskId(taskId);
    if (workerId) setActiveWorkerId(workerId);
    setStatus("loading_task");
    setError(null);
    try {
      const nextBundle = await workerApi.getTask(taskId);
      if (epoch !== epochRef.current) return false;
      setActiveWorkerId(nextBundle.task.workerId);
      renderBundle(nextBundle, { preserveLocal: false });
      setStatus("ready");
      onSelectionChangeRef.current?.({
        taskId,
        workerId: nextBundle.task.workerId,
      });
      const subscribed = startSubscription(taskId, nextBundle, epoch);
      if (!subscribed && isWorkerConversationBusy(nextBundle.conversation)) {
        pollTask(taskId, epoch).catch(reportError);
      }
      return true;
    } catch (nextError) {
      if (epoch !== epochRef.current) return false;
      setStatus("error");
      reportError(nextError);
      return false;
    }
  }, [pollTask, renderBundle, reportError, startSubscription]);

  const load = useCallback(async () => {
    const epoch = epochRef.current + 1;
    epochRef.current = epoch;
    setStatus("loading");
    setError(null);
    try {
      const [rawDefinitions, rawTasks, rawConnections] = await Promise.all([
        workerApi.listDefinitions(),
        workerApi.listTasks(),
        workerApi.listConnections(),
      ]);
      if (epoch !== epochRef.current) return;
      const nextDefinitions = normalizeWorkerDefinitions(rawDefinitions);
      const nextConnections = normalizeWorkerConnections(rawConnections, nextDefinitions);
      definitionsRef.current = nextDefinitions;
      connectionsRef.current = nextConnections;
      setDefinitions(nextDefinitions);
      setConnections(nextConnections);
      setTasks(rawTasks);
      const preferred = rawTasks.find((task) => task.id === preferredTaskId)
        ?? rawTasks[0]
        ?? null;
      setActiveWorkerId(preferred?.workerId ?? nextDefinitions[0]?.id ?? null);
      if (!preferred) {
        activeTaskIdRef.current = null;
        setActiveTaskId(null);
        setBundle(null);
        setState(null);
        setStatus("ready");
        initializedRef.current = true;
        return;
      }
      activeTaskIdRef.current = preferred.id;
      setActiveTaskId(preferred.id);
      const nextBundle = await workerApi.getTask(preferred.id);
      if (epoch !== epochRef.current) return;
      renderBundle(nextBundle, { preserveLocal: false });
      setStatus("ready");
      initializedRef.current = true;
      onSelectionChangeRef.current?.({ taskId: preferred.id, workerId: preferred.workerId });
      const subscribed = startSubscription(preferred.id, nextBundle, epoch);
      if (!subscribed && isWorkerConversationBusy(nextBundle.conversation)) {
        pollTask(preferred.id, epoch).catch(reportError);
      }
    } catch (nextError) {
      if (epoch !== epochRef.current) return;
      setStatus("error");
      reportError(nextError);
    }
  }, [pollTask, preferredTaskId, renderBundle, reportError, startSubscription]);

  useEffect(() => {
    if (!active || initializedRef.current) return;
    load();
  }, [active, load]);

  useEffect(() => () => {
    epochRef.current += 1;
    unsubscribeRef.current?.();
  }, []);

  useEffect(() => {
    if (active) return;
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    subscribedTaskIdRef.current = null;
  }, [active]);

  useEffect(() => {
    if (
      !active
      || !initializedRef.current
      || !bundleRef.current
      || subscribedTaskIdRef.current === activeTaskIdRef.current
    ) return;
    startSubscription(activeTaskIdRef.current, bundleRef.current, epochRef.current);
  }, [active, startSubscription]);

  useEffect(() => {
    projectOptionsRef.current = projectOptions;
    if (bundleRef.current) renderBundle(bundleRef.current);
  }, [projectOptions, renderBundle]);

  const dispatch = useCallback((action) => {
    setState((current) => (current ? workerReducer(current, action) : current));
  }, []);

  const selectWorker = useCallback((workerId) => {
    const recentTask = tasks.find((task) => task.workerId === workerId);
    if (recentTask) return selectTask(recentTask.id, workerId);
    draftInvalidationCoordinatorRef.current.reset();
    epochRef.current += 1;
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    subscribedTaskIdRef.current = null;
    activeTaskIdRef.current = null;
    bundleRef.current = null;
    setActiveWorkerId(workerId);
    setActiveTaskId(null);
    setBundle(null);
    setState(null);
    setStatus("ready");
    onSelectionChangeRef.current?.({ taskId: null, workerId });
    return Promise.resolve(true);
  }, [selectTask, tasks]);

  const createTask = useCallback(async (input) => {
    const workerId = typeof input === "string" ? input : input?.workerId;
    const title = typeof input === "object" ? input?.title : "新任务";
    if (!workerId || !title?.trim()) return false;
    setBusyAction("create_task");
    setError(null);
    try {
      const created = await workerApi.createTask({ workerId, title: title.trim() });
      const nextTasks = await workerApi.listTasks();
      setTasks(nextTasks);
      return selectTask(created.task.id, workerId);
    } catch (nextError) {
      reportError(nextError);
      return false;
    } finally {
      setBusyAction(null);
    }
  }, [reportError, selectTask]);

  const runTaskMutation = useCallback(async (name, operation, { poll = false } = {}) => {
    const taskId = activeTaskIdRef.current;
    if (!taskId) return false;
    const epoch = epochRef.current;
    setBusyAction(name);
    setError(null);
    try {
      await operation(taskId);
      if (poll && subscribedTaskIdRef.current === taskId) {
        return true;
      }
      const nextBundle = await refreshTask(taskId, { epoch });
      if (
        poll
        && nextBundle
        && isWorkerConversationBusy(nextBundle.conversation)
        && subscribedTaskIdRef.current !== taskId
      ) {
        await pollTask(taskId, epoch);
      }
      return true;
    } catch (nextError) {
      await refreshTask(taskId, { epoch }).catch(() => undefined);
      reportError(nextError);
      return false;
    } finally {
      setBusyAction(null);
    }
  }, [pollTask, refreshTask, reportError]);

  const sendMessage = useCallback((input) => runTaskMutation(
    "message",
    async (taskId) => {
      const attachments = pendingAttachmentsRef.current.get(taskId) ?? [];
      const current = state;
      await workerRequest(`/api/v1/worker/tasks/${encodeURIComponent(taskId)}/messages`, {
        body: {
          schema_version: 1,
          client_request_id: requestId("worker-message"),
          text: input.content,
          provider_id: current?.providerId || defaultProviderId,
          model_id: current?.modelId || defaultModelId,
          thinking_level: current?.thinkingLevel ?? undefined,
          attachments: attachments.map(serializeAttachment),
          images: [],
        },
      });
      pendingAttachmentsRef.current.set(taskId, []);
    },
    { poll: true },
  ), [defaultModelId, defaultProviderId, runTaskMutation, state]);

  const invalidateDraftOnEdit = useCallback((input) => {
    const taskId = activeTaskIdRef.current;
    if (!taskId || taskId !== input?.taskId || !input?.draftRevisionId) return false;
    setError(null);
    return draftInvalidationCoordinatorRef.current.invalidateOnce(
      { taskId, draftRevisionId: input.draftRevisionId },
      {
        invalidate: () => workerApi.invalidateDraft(taskId, input.draftRevisionId),
        refresh: () => refreshTask(taskId),
        onError: reportError,
      },
    );
  }, [refreshTask, reportError]);

  const saveDraft = useCallback(async (input) => {
    const saved = await runTaskMutation(
      "save_draft",
      (taskId) => workerApi.saveDraft(taskId, {
        content: input.content,
        format: input.format,
        source: input.source,
      }),
    );
    if (saved) draftInvalidationCoordinatorRef.current.reset(input.taskId);
    return saved;
  }, [runTaskMutation]);

  const updateProjectContext = useCallback((input) => runTaskMutation(
    "project_context",
    (taskId) => workerApi.updateTaskContext(taskId, input.projectContext?.id ?? null),
  ), [runTaskMutation]);

  const configureModel = useCallback(({ providerId, modelId, thinkingLevel }) => runTaskMutation(
    "model",
    (taskId) => workerRequest(
      `/api/v1/worker/tasks/${encodeURIComponent(taskId)}/configuration`,
      {
        body: {
          schema_version: 1,
          provider_id: providerId,
          model_id: modelId,
          thinking_level: thinkingLevel,
        },
      },
    ),
  ), [runTaskMutation]);

  const proposeDelivery = useCallback((input) => runTaskMutation(
    "propose_delivery",
    (taskId) => workerApi.proposeAction(
      taskId,
      buildWorkerActionInput(
        state?.worker?.id,
        input.operation,
        input.values,
        state?.sources,
      ),
    ),
  ), [runTaskMutation, state?.sources, state?.worker?.id]);

  const confirmDelivery = useCallback((input) => runTaskMutation(
    "confirm_delivery",
    (taskId) => workerApi.confirmAction(taskId, input.actionId, {
      proposalHash: input.proposalHash,
      draftSha256: input.draftHash ?? null,
      baseRevisionId: input.baseRevisionId ?? null,
    }),
  ), [runTaskMutation]);

  const abandonDelivery = useCallback((input) => runTaskMutation(
    "abandon_delivery",
    (taskId) => workerApi.abandonAction(taskId, input.actionId, {
      reason: input.reason,
      manualCheckCompleted: input.manualCheckCompleted === true,
    }),
  ), [runTaskMutation]);

  const retryDelivery = useCallback((input) => runTaskMutation(
    "retry_delivery",
    (taskId) => workerApi.retryAction(taskId, input.actionId),
  ), [runTaskMutation]);

  const runtimeAction = useCallback((operation) => runTaskMutation(
    operation,
    (taskId) => workerRequest(
      `/api/v1/worker/tasks/${encodeURIComponent(taskId)}/${operation}`,
      {
        body: {
          schema_version: 1,
          client_request_id: requestId(`worker-${operation}`),
        },
      },
    ),
    { poll: operation !== "abort" },
  ), [runTaskMutation]);

  const answerAskUser = useCallback((request, answers) => runTaskMutation(
    "answer_user",
    (taskId) => workerApi.answerQuestion(taskId, request.id, answers),
    { poll: true },
  ), [runTaskMutation]);

  const cancelAskUser = useCallback((request) => runTaskMutation(
    "cancel_user",
    (taskId) => workerApi.cancelQuestion(taskId, request.id),
  ), [runTaskMutation]);

  const checkConnection = useCallback(async (workerId) => {
    const existing = connectionsRef.current[workerId] ?? {};
    const checking = connectionMapWithStatus(connectionsRef.current, workerId, {
      ...existing,
      status: "checking",
      label: "正在检查连接",
    });
    connectionsRef.current = checking;
    setConnections(checking);
    if (bundleRef.current) renderBundle(bundleRef.current);
    setBusyAction("check_connection");
    try {
      const checked = await workerApi.checkConnection(workerId);
      const normalized = normalizeWorkerConnections([checked], definitionsRef.current);
      const next = {
        ...connectionsRef.current,
        ...normalized,
      };
      connectionsRef.current = next;
      setConnections(next);
      if (bundleRef.current) renderBundle(bundleRef.current);
      return true;
    } catch (nextError) {
      const failed = connectionMapWithStatus(connectionsRef.current, workerId, {
        ...existing,
        status: "degraded",
        label: `连接检查失败 · ${nextError?.message || "请稍后重试"}`,
        verified: false,
        reason: nextError?.message || "连接检查失败",
      });
      connectionsRef.current = failed;
      setConnections(failed);
      if (bundleRef.current) renderBundle(bundleRef.current);
      reportError(nextError);
      return false;
    } finally {
      setBusyAction(null);
    }
  }, [renderBundle, reportError]);

  const addPendingAttachment = useCallback((taskId, attachment) => {
    const current = pendingAttachmentsRef.current.get(taskId) ?? [];
    const next = [...current.filter((item) => item.id !== attachment.id), attachment];
    pendingAttachmentsRef.current.set(taskId, next);
    if (bundleRef.current?.task?.id === taskId) renderBundle(bundleRef.current);
  }, [renderBundle]);

  const uploadAttachment = useCallback(async (file) => {
    const taskId = activeTaskIdRef.current;
    const conversationId = unwrapWorkerConversation(bundleRef.current?.conversation)?.id;
    if (!taskId || !conversationId || !file) return false;
    setBusyAction("upload_attachment");
    try {
      const attachment = await projectWorkApi.uploadAttachment({ conversationId, file });
      addPendingAttachment(taskId, attachment);
      const sources = importedSourcesRef.current.get(taskId) ?? [];
      importedSourcesRef.current.set(taskId, [...sources, {
        id: `uploaded:${attachment.id}`,
        kind: "attachment",
        label: attachment.fileName,
        detail: "已上传 · 将随下一条消息提供给 Agent",
        attachment,
      }]);
      renderBundle(bundleRef.current);
      return true;
    } catch (nextError) {
      reportError(nextError);
      return false;
    } finally {
      setBusyAction(null);
    }
  }, [addPendingAttachment, renderBundle, reportError]);

  const uploadDeliveryAttachment = useCallback(async (file) => {
    const taskId = activeTaskIdRef.current;
    if (!taskId || !file) return false;
    setBusyAction("upload_delivery_attachment");
    setError(null);
    try {
      await workerApi.uploadTaskFile(taskId, file);
      await refreshTask(taskId);
      return true;
    } catch (nextError) {
      await refreshTask(taskId).catch(() => undefined);
      reportError(nextError);
      return false;
    } finally {
      setBusyAction(null);
    }
  }, [refreshTask, reportError]);

  const removeDeliveryAttachment = useCallback(async (fileId) => {
    const taskId = activeTaskIdRef.current;
    if (!taskId || !fileId) return false;
    setBusyAction("remove_delivery_attachment");
    setError(null);
    try {
      await workerApi.removeTaskFile(taskId, fileId);
      await refreshTask(taskId);
      return true;
    } catch (nextError) {
      await refreshTask(taskId).catch(() => undefined);
      reportError(nextError);
      return false;
    } finally {
      setBusyAction(null);
    }
  }, [refreshTask, reportError]);

  const readSource = useCallback(async ({ operation, values }) => {
    const taskId = activeTaskIdRef.current;
    const workerId = bundleRef.current?.task?.workerId;
    if (!taskId || !workerId) return false;
    setBusyAction("read_source");
    setError(null);
    try {
      const input = buildWorkerReadInput(workerId, operation, values);
      await workerRequest(
        `/api/v1/worker/tasks/${encodeURIComponent(taskId)}/read`,
        { body: { schema_version: 1, ...input } },
      );
      await refreshTask(taskId);
      return true;
    } catch (nextError) {
      reportError(nextError);
      return false;
    } finally {
      setBusyAction(null);
    }
  }, [refreshTask, reportError]);

  const removePendingAttachment = useCallback((attachmentId) => {
    const taskId = activeTaskIdRef.current;
    if (!taskId) return;
    const next = (pendingAttachmentsRef.current.get(taskId) ?? [])
      .filter((item) => item.id !== attachmentId);
    pendingAttachmentsRef.current.set(taskId, next);
    if (bundleRef.current) renderBundle(bundleRef.current);
  }, [renderBundle]);

  const useSource = useCallback((source) => {
    const taskId = activeTaskIdRef.current;
    if (taskId && source?.attachment) addPendingAttachment(taskId, source.attachment);
  }, [addPendingAttachment]);

  const displayTasks = useMemo(
    () => normalizeWorkerTasks(tasks, state),
    [state, tasks],
  );

  return {
    status,
    busyAction,
    error,
    definitions,
    tasks: displayTasks,
    connections,
    activeWorkerId,
    activeTaskId,
    state,
    bundle,
    dispatch,
    load,
    selectWorker,
    selectTask,
    createTask,
    sendMessage,
    invalidateDraftOnEdit,
    saveDraft,
    updateProjectContext,
    configureModel,
    proposeDelivery,
    confirmDelivery,
    abandonDelivery,
    retryDelivery,
    abort: () => runtimeAction("abort"),
    retryLastTurn: () => runtimeAction("retry-last-turn"),
    compact: () => runtimeAction("compact"),
    answerAskUser,
    cancelAskUser,
    checkConnection,
    uploadAttachment,
    uploadDeliveryAttachment,
    removeDeliveryAttachment,
    readSource,
    removePendingAttachment,
    useSource,
  };
}
