import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GatewayClient } from "../gateway/client.js";
import {
  createChatEvent,
  createSessionAgentHarness,
  promptAgent,
} from "./translator.prompt-harness.test-support.js";

async function createHarness(options: { itemId?: string } = { itemId: "preamble-1" }) {
  const sent = createDeferred<string>();
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "chat.send") {
      if (typeof params?.idempotencyKey !== "string") {
        throw new Error("missing run ID");
      }
      sent.resolve(params.idempotencyKey);
    }
    return {};
  }) as GatewayClient["request"];
  const harness = createSessionAgentHarness(request);
  const prompt = promptAgent(harness.agent);
  const runId = await sent.promise;
  const chat = (payload: Record<string, unknown>) =>
    harness.agent.handleGatewayEvent(
      createChatEvent({ sessionKey: harness.sessionKey, runId, ...payload }),
    );
  const item = (data: Record<string, unknown>, payload: Record<string, unknown> = {}) =>
    harness.agent.handleGatewayEvent({
      type: "event",
      event: "agent",
      payload: {
        sessionKey: harness.sessionKey,
        runId,
        stream: "item",
        data: {
          kind: "preamble",
          ...(options.itemId ? { itemId: options.itemId } : {}),
          phase: "update",
          ...data,
        },
        ...payload,
      },
    });
  return { ...harness, prompt, runId, chat, item };
}

function messageChunks(harness: Awaited<ReturnType<typeof createHarness>>) {
  return harness.sessionUpdate.mock.calls.flatMap(([notification]) =>
    notification.update.sessionUpdate === "agent_message_chunk"
      ? [notification.update.content.text]
      : [],
  );
}

describe("ACP commentary", () => {
  it.each([{ itemId: "preamble-1" }, {}])(
    "streams cumulative preambles with item ID '$itemId' around tools without consuming the final answer",
    async (options) => {
      const harness = await createHarness(options);
      await harness.item({ progressText: "Stale" }, { runId: "old-run" });
      await harness.item(
        { progressText: "Other session" },
        { sessionKey: "agent:other:main", runId: "other-run" },
      );
      await harness.item({ kind: "reasoning", progressText: "Private" });

      const delivery = createDeferred();
      harness.sessionUpdate.mockReturnValueOnce(delivery.promise);
      const first = harness.item({ progressText: "Work" });
      expect(messageChunks(harness)).toEqual(["Work"]);
      await harness.item({ phase: "end", progressText: "Work" });
      await harness.agent.handleGatewayEvent({
        type: "event",
        event: "agent",
        payload: {
          sessionKey: harness.sessionKey,
          runId: harness.runId,
          stream: "tool",
          data: { phase: "start", toolCallId: "tool-1", name: "read", args: { path: "app.ts" } },
        },
      });
      await harness.item({ progressText: "Working" });
      await harness.item({ phase: "end", progressText: "Working" });
      await harness.item({ progressText: "Work" });
      delivery.resolve();
      await first;
      await harness.item({ itemId: "preamble-2", phase: "end", progressText: "Working" });
      await harness.chat({
        state: "final",
        message: { content: [{ type: "text", text: "Done" }] },
      });
      await expect(harness.prompt).resolves.toEqual({ stopReason: "end_turn" });
      await harness.item({ itemId: "late-item", progressText: "Late" });
      expect(messageChunks(harness)).toEqual(["Work", "ing", "Working", "Done"]);
      expect(
        harness.sessionUpdate.mock.calls
          .map(([notification]) => notification.update.sessionUpdate)
          .filter((type) => type === "agent_message_chunk" || type === "tool_call"),
      ).toEqual([
        "agent_message_chunk",
        "tool_call",
        "agent_message_chunk",
        "agent_message_chunk",
        "agent_message_chunk",
      ]);
    },
  );

  it("preserves withdrawn narration across textless chat snapshots", async () => {
    const harness = await createHarness();
    await harness.chat({
      state: "delta",
      message: { content: [{ type: "text", text: "Working" }] },
    });
    await harness.chat({ state: "delta", replace: true, deltaText: "" });
    await harness.chat({
      state: "delta",
      message: { content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }] },
    });
    await harness.chat({ state: "delta", deltaText: "" });
    await harness.item({ phase: "end", progressText: "Working" });
    await harness.chat({
      state: "final",
      message: { content: [{ type: "text", text: "Done" }] },
    });
    await expect(harness.prompt).resolves.toEqual({ stopReason: "end_turn" });
    expect(messageChunks(harness)).toEqual(["Working", "Done"]);
  });

  it.each([
    { retained: "", separator: "" },
    { retained: "Accepted answer.", separator: "\n" },
    { retained: "Accepted answer.", separator: "\n\n" },
  ])(
    "deduplicates reclassified chat text with prefix '$retained' and separator '$separator'",
    async ({ retained, separator }) => {
      const harness = await createHarness();
      await harness.chat({
        state: "delta",
        message: {
          content: [{ type: "text", text: `${retained}${separator}  Checking a detail.` }],
        },
      });
      await harness.chat({ state: "delta", replace: true, deltaText: retained });
      await harness.item({ progressText: "  Checking a detail. Now reading." });
      await harness.item({ phase: "end", progressText: "  Checking a detail. Now reading." });
      await harness.chat({
        state: "final",
        message: { content: [{ type: "text", text: `${retained} Done.` }] },
      });
      await expect(harness.prompt).resolves.toEqual({ stopReason: "end_turn" });
      expect(messageChunks(harness)).toEqual([
        `${retained}${separator}  Checking a detail.`,
        " Now reading.",
        " Done.",
      ]);
    },
  );
});
