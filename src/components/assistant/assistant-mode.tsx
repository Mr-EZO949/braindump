"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpIcon, ChevronDownIcon, CloseIcon, PlusIcon } from "@/components/ui/icons";
import type { GraphData } from "@/types/graph";

// ── Types ──────────────────────────────────────────────────────────────────────

type PlanTask = {
  id: string;
  title: string;
  done: boolean;
  date: string | null; // "YYYY-MM-DD" or null = unscheduled
};

type AssistantMessage = {
  id: string;
  role: "user" | "assistant";
  body: string;
};

type Conversation = {
  id: string;
  title: string;
  messages: AssistantMessage[];
  createdAt: string;
};

// ── Storage helpers ────────────────────────────────────────────────────────────

function sk(prefix: string, workspaceId: string | null) {
  return `tr_${prefix}_${workspaceId ?? "null"}`;
}

function loadTasks(workspaceId: string | null): PlanTask[] {
  try {
    return JSON.parse(localStorage.getItem(sk("tasks", workspaceId)) ?? "[]") as PlanTask[];
  } catch {
    return [];
  }
}

function saveTasks(workspaceId: string | null, tasks: PlanTask[]) {
  localStorage.setItem(sk("tasks", workspaceId), JSON.stringify(tasks));
}

function loadConversations(workspaceId: string | null): Conversation[] {
  try {
    return JSON.parse(
      localStorage.getItem(sk("convs", workspaceId)) ?? "[]",
    ) as Conversation[];
  } catch {
    return [];
  }
}

function saveConversations(workspaceId: string | null, convs: Conversation[]) {
  localStorage.setItem(sk("convs", workspaceId), JSON.stringify(convs));
}

function loadCurrentConvId(workspaceId: string | null): string | null {
  return localStorage.getItem(sk("cur_conv", workspaceId));
}

function saveCurrentConvId(workspaceId: string | null, id: string | null) {
  if (id) {
    localStorage.setItem(sk("cur_conv", workspaceId), id);
  } else {
    localStorage.removeItem(sk("cur_conv", workspaceId));
  }
}

// ── Date helpers ───────────────────────────────────────────────────────────────

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function getWeekDays(anchor: Date): Date[] {
  const day = anchor.getDay();
  const monday = new Date(anchor);
  monday.setDate(anchor.getDate() - ((day + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const dd = new Date(monday);
    dd.setDate(monday.getDate() + i);
    return dd;
  });
}

const DAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const QUICK_ACTIONS = ["1h focus", "2h session", "Plan today", "What's next?"];

const STARTER_PROMPTS = [
  "Suggest a 1-hour focus plan",
  "What should I work on next?",
  "Break down my most important project",
  "Plan my day",
];

// ── Component ──────────────────────────────────────────────────────────────────

type AssistantModeProps = {
  graphData: GraphData;
  selectedNodeId: string | null;
  workspaceId: string | null;
  workspaceName: string;
};

export function AssistantMode({
  graphData,
  selectedNodeId,
  workspaceId,
  workspaceName,
}: AssistantModeProps) {
  const today = toDateString(new Date());
  const weekDays = getWeekDays(new Date());

  // Planner state
  const [tasks, setTasks] = useState<PlanTask[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const [addingSection, setAddingSection] = useState<string | null>(null);
  const [newTaskTitle, setNewTaskTitle] = useState("");

  // Conversation state
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Context chip
  const [contextDismissed, setContextDismissed] = useState(false);

  const threadEndRef = useRef<HTMLDivElement>(null);
  const addTaskRef = useRef<HTMLInputElement>(null);

  // ── Load from storage ──────────────────────────────────────────────────────

  useEffect(() => {
    setTasks(loadTasks(workspaceId));
    const convs = loadConversations(workspaceId);
    setConversations(convs);
    const savedId = loadCurrentConvId(workspaceId);
    setCurrentConvId(
      savedId && convs.some((c) => c.id === savedId)
        ? savedId
        : convs[0]?.id ?? null,
    );
    setContextDismissed(false);
    setSelectedDate(today);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // ── Derived ────────────────────────────────────────────────────────────────

  const currentConv = conversations.find((c) => c.id === currentConvId) ?? null;
  const messages = currentConv?.messages ?? [];
  const selectedNode = graphData.nodes.find((n) => n.id === selectedNodeId) ?? null;
  const showContext = Boolean(selectedNode && !contextDismissed);

  const activeTasks = tasks.filter((t) => !t.done);
  const doneTasks = tasks.filter((t) => t.done);

  // Per-date task counts for week strip badges
  const countByDate = weekDays.reduce<Record<string, number>>((acc, day) => {
    const ds = toDateString(day);
    acc[ds] = activeTasks.filter((t) => t.date === ds).length;
    return acc;
  }, {});

  // Task sections for current view
  const viewTasks =
    selectedDate === "all"
      ? activeTasks
      : activeTasks.filter((t) => t.date === selectedDate);
  const unscheduled = activeTasks.filter((t) => !t.date);

  // ── Persistence wrappers ───────────────────────────────────────────────────

  const persistTasks = useCallback(
    (next: PlanTask[]) => {
      setTasks(next);
      saveTasks(workspaceId, next);
    },
    [workspaceId],
  );

  const persistConvs = useCallback(
    (next: Conversation[], nextId?: string | null) => {
      setConversations(next);
      saveConversations(workspaceId, next);
      if (nextId !== undefined) {
        setCurrentConvId(nextId);
        saveCurrentConvId(workspaceId, nextId);
      }
    },
    [workspaceId],
  );

  // ── Auto-scroll ────────────────────────────────────────────────────────────

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, loading]);

  // ── Focus add-task input ───────────────────────────────────────────────────

  useEffect(() => {
    if (addingSection) addTaskRef.current?.focus();
  }, [addingSection]);

  // ── Close history popover on outside click ─────────────────────────────────

  useEffect(() => {
    if (!historyOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Element;
      if (!target.closest(".conv-history-popover") && !target.closest(".conv-switcher")) {
        setHistoryOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [historyOpen]);

  // ── Task operations ────────────────────────────────────────────────────────

  const addTask = (date: string | null) => {
    const title = newTaskTitle.trim();
    setAddingSection(null);
    setNewTaskTitle("");
    if (!title) return;
    persistTasks([
      ...tasks,
      { id: `t-${Date.now()}`, title, done: false, date },
    ]);
  };

  const toggleTask = (id: string) =>
    persistTasks(tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));

  const deleteTask = (id: string) =>
    persistTasks(tasks.filter((t) => t.id !== id));

  // ── Conversation operations ────────────────────────────────────────────────

  const newConversation = () => {
    const conv: Conversation = {
      id: `conv-${Date.now()}`,
      title: "New conversation",
      messages: [],
      createdAt: new Date().toISOString(),
    };
    persistConvs([conv, ...conversations], conv.id);
    setHistoryOpen(false);
  };

  // ── Chat ───────────────────────────────────────────────────────────────────

  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    setChatInput("");
    setLoading(true);

    let working = currentConv;
    if (!working) {
      working = {
        id: `conv-${Date.now()}`,
        title: trimmed.slice(0, 48),
        messages: [],
        createdAt: new Date().toISOString(),
      };
    }

    const userMsg: AssistantMessage = { id: `u-${Date.now()}`, role: "user", body: trimmed };
    const updated: Conversation = {
      ...working,
      title: working.messages.length === 0 ? trimmed.slice(0, 48) : working.title,
      messages: [...working.messages, userMsg],
    };

    const nextConvs = conversations.some((c) => c.id === updated.id)
      ? conversations.map((c) => (c.id === updated.id ? updated : c))
      : [updated, ...conversations];

    persistConvs(nextConvs, updated.id);

    await new Promise<void>((resolve) => setTimeout(resolve, 380));

    const aMsg: AssistantMessage = {
      id: `a-${Date.now()}`,
      role: "assistant",
      body: `I have full workspace context for "${workspaceName}". I can help plan your work, break down projects, and suggest what to tackle next. AI response wiring coming in the next pass.`,
    };

    const final: Conversation = { ...updated, messages: [...updated.messages, aMsg] };
    const finalConvs = nextConvs.map((c) => (c.id === final.id ? final : c));
    persistConvs(finalConvs, final.id);
    setLoading(false);
  };

  // ── Render helpers ─────────────────────────────────────────────────────────

  const TaskRow = ({ task }: { task: PlanTask }) => (
    <div className="planner-task-row" key={task.id}>
      <button
        aria-label={task.done ? "Mark undone" : "Mark done"}
        className={`planner-task-check${task.done ? " planner-task-check-done" : ""}`}
        onClick={() => toggleTask(task.id)}
        type="button"
      />
      <span className={`planner-task-title${task.done ? " planner-task-title-done" : ""}`}>
        {task.title}
      </span>
      <button
        aria-label="Delete task"
        className="planner-task-delete"
        onClick={() => deleteTask(task.id)}
        type="button"
      >
        <CloseIcon className="h-[11px] w-[11px]" />
      </button>
    </div>
  );

  const AddTaskRow = ({ sectionKey, date }: { sectionKey: string; date: string | null }) =>
    addingSection === sectionKey ? (
      <div className="planner-add-row">
        <input
          className="planner-add-input"
          onBlur={() => addTask(date)}
          onChange={(e) => setNewTaskTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addTask(date);
            if (e.key === "Escape") {
              setAddingSection(null);
              setNewTaskTitle("");
            }
          }}
          placeholder="Task name..."
          ref={addTaskRef}
          type="text"
          value={newTaskTitle}
        />
      </div>
    ) : (
      <button
        className="planner-add-trigger"
        onClick={() => {
          setAddingSection(sectionKey);
          setNewTaskTitle("");
        }}
        type="button"
      >
        <PlusIcon className="h-[11px] w-[11px]" />
        Add task
      </button>
    );

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="assistant-layout">
      {/* Context chip bar */}
      {showContext ? (
        <div className="assistant-context-bar">
          <span className="assistant-context-chip">
            <span className="assistant-context-chip-label">Context</span>
            <span className="assistant-context-chip-name">{selectedNode!.title}</span>
            <button
              aria-label="Clear context"
              className="assistant-context-chip-dismiss"
              onClick={() => setContextDismissed(true)}
              type="button"
            >
              <CloseIcon className="h-[10px] w-[10px]" />
            </button>
          </span>
        </div>
      ) : null}

      <div className="assistant-workspace">
        {/* ── LEFT: Planner ── */}
        <div className="assistant-planner shell-scrollbar">
          {/* Quick action chips */}
          <div className="planner-quick-row">
            {QUICK_ACTIONS.map((action) => (
              <button
                className="assistant-quick-chip"
                key={action}
                onClick={() => void sendMessage(action)}
                type="button"
              >
                {action}
              </button>
            ))}
          </div>

          {/* Week strip */}
          <div className="week-strip">
            {weekDays.map((day, i) => {
              const ds = toDateString(day);
              const isToday = ds === today;
              const count = countByDate[ds] ?? 0;
              return (
                <button
                  className="week-day-btn"
                  data-active={selectedDate === ds}
                  data-today={isToday || undefined}
                  key={ds}
                  onClick={() => setSelectedDate(ds)}
                  type="button"
                >
                  <span className="week-day-abbr">{DAY_ABBR[i]}</span>
                  <span className={`week-day-num${isToday ? " week-day-num-today" : ""}`}>
                    {day.getDate()}
                  </span>
                  {count > 0 ? <span className="week-day-dot" /> : null}
                </button>
              );
            })}
          </div>

          {/* Task sections */}
          <div className="planner-sections">
            {/* Selected day tasks */}
            <div className="planner-section">
              <p className="planner-section-label">
                {selectedDate === today
                  ? "Today"
                  : new Date(`${selectedDate}T12:00:00`).toLocaleDateString("en-US", {
                      weekday: "long",
                      month: "short",
                      day: "numeric",
                    })}
              </p>
              {viewTasks.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
              <AddTaskRow date={selectedDate} sectionKey={`date-${selectedDate}`} />
            </div>

            {/* Unscheduled */}
            <div className="planner-section">
              <p className="planner-section-label">Unscheduled</p>
              {unscheduled.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
              <AddTaskRow date={null} sectionKey="unscheduled" />
            </div>

            {/* Done count */}
            {doneTasks.length > 0 ? (
              <div className="planner-done-summary">
                {doneTasks.length} completed
              </div>
            ) : null}
          </div>
        </div>

        {/* ── RIGHT: Chat column ── */}
        <div className="assistant-chat-col">
          {/* Header */}
          <div className="chat-col-header">
            <div className="relative">
              <button
                className="conv-switcher"
                onClick={() => setHistoryOpen((o) => !o)}
                type="button"
              >
                <span className="conv-switcher-title truncate">
                  {currentConv?.title ?? "New conversation"}
                </span>
                <ChevronDownIcon
                  className={`h-[12px] w-[12px] shrink-0 transition-transform duration-150 ${
                    historyOpen ? "rotate-180" : ""
                  }`}
                />
              </button>

              <AnimatePresence>
                {historyOpen ? (
                  <motion.div
                    className="conv-history-popover"
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    initial={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.13 }}
                  >
                    <button
                      className="conv-history-new"
                      onClick={newConversation}
                      type="button"
                    >
                      <PlusIcon className="h-[12px] w-[12px]" />
                      New conversation
                    </button>
                    {conversations.length > 0 ? (
                      <div className="conv-history-list">
                        {conversations.map((conv) => (
                          <button
                            className={`conv-history-item${
                              conv.id === currentConvId ? " conv-history-item-active" : ""
                            }`}
                            key={conv.id}
                            onClick={() => {
                              setCurrentConvId(conv.id);
                              saveCurrentConvId(workspaceId, conv.id);
                              setHistoryOpen(false);
                            }}
                            type="button"
                          >
                            <span className="truncate">{conv.title}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>

            <button
              aria-label="New conversation"
              className="chat-col-new-btn"
              onClick={newConversation}
              title="New conversation"
              type="button"
            >
              <PlusIcon className="h-[13px] w-[13px]" />
            </button>
          </div>

          {/* Thread or starter */}
          <div className="chat-thread shell-scrollbar">
            {messages.length === 0 && !loading ? (
              <div className="chat-starter-state">
                <p className="chat-starter-heading">What are we working on?</p>
                <p className="chat-starter-sub">
                  Ask for a plan, break down a project, or ask what to tackle next.
                </p>
                <div className="chat-starter-prompts">
                  {STARTER_PROMPTS.map((prompt) => (
                    <button
                      className="chat-starter-prompt"
                      key={prompt}
                      onClick={() => void sendMessage(prompt)}
                      type="button"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="chat-messages">
                {messages.map((msg) =>
                  msg.role === "user" ? (
                    <div className="chat-msg-user" key={msg.id}>
                      <p>{msg.body}</p>
                    </div>
                  ) : (
                    <div className="chat-msg-assistant" key={msg.id}>
                      <p>{msg.body}</p>
                    </div>
                  ),
                )}
                {loading ? (
                  <div className="chat-msg-assistant">
                    <div className="chat-loading-indicator" aria-live="polite">
                      <span className="text-[12px] font-medium text-[var(--color-text-secondary)]">
                        Thinking
                      </span>
                      <span className="chat-loading-dot" />
                      <span className="chat-loading-dot" />
                      <span className="chat-loading-dot" />
                    </div>
                  </div>
                ) : null}
                <div ref={threadEndRef} />
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="chat-col-composer">
            <div className="chat-composer-row">
              <textarea
                className="chat-composer-input"
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendMessage(chatInput);
                  }
                }}
                placeholder="Ask for a plan, breakdown, or next steps..."
                rows={1}
                value={chatInput}
              />
              <button
                aria-label="Send"
                className="composer-send-button"
                disabled={loading || chatInput.trim().length === 0}
                onClick={() => void sendMessage(chatInput)}
                type="button"
              >
                <ArrowUpIcon className="h-[15px] w-[15px]" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
