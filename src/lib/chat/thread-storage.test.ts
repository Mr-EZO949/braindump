import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "@/types/chat";

import { CHAT_HISTORY_MAX, readChatHistory, readChatSessionId, writeChatHistory, writeChatSessionId } from "./thread-storage";

const msg = (i: number): ChatMessage => ({ id: `m${i}`, role: "user", body: `b${i}`, createdAt: "t" });

describe("thread storage", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the thread per user and workspace, trimmed to the newest messages", () => {
    writeChatHistory("u", "w", Array.from({ length: CHAT_HISTORY_MAX + 5 }, (_, i) => msg(i)));
    const back = readChatHistory("u", "w");
    expect(back).toHaveLength(CHAT_HISTORY_MAX);
    expect(back[0].id).toBe("m5");
    expect(readChatHistory("u", "other")).toEqual([]);
    expect(store.has("brain-dump:chat-history:u:w")).toBe(true);
  });

  it("does nothing without a user or workspace, and survives bad JSON", () => {
    writeChatHistory(null, "w", [msg(1)]);
    expect(store.size).toBe(0);
    expect(readChatHistory("u", null)).toEqual([]);
    store.set("brain-dump:chat-history:u:w", "{not json");
    expect(readChatHistory("u", "w")).toEqual([]);
    store.set("brain-dump:chat-history:u:w", '{"a":1}');
    expect(readChatHistory("u", "w")).toEqual([]);
  });

  it("stores and clears the session id", () => {
    writeChatSessionId("u", "w", "s1");
    expect(readChatSessionId("u", "w")).toBe("s1");
    writeChatSessionId("u", "w", null);
    expect(readChatSessionId("u", "w")).toBeNull();
    expect(readChatSessionId(null, "w")).toBeNull();
  });
});

describe("thread storage without a window", () => {
  it("reads nothing and writes nothing on the server", () => {
    expect(readChatHistory("u", "w")).toEqual([]);
    expect(readChatSessionId("u", "w")).toBeNull();
    expect(() => writeChatHistory("u", "w", [msg(1)])).not.toThrow();
    expect(() => writeChatSessionId("u", "w", "s")).not.toThrow();
  });
});
