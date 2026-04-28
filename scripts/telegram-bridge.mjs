/**
 * telegram-bridge.mjs
 *
 * Bridges Telegram Bot API ↔ CrabTalk directly via TCP protobuf.
 * No NATS required — talks to CrabTalk daemon on localhost:6688.
 *
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN      - Telegram bot token (required)
 *   TELEGRAM_POLL_TIMEOUT   - Long-poll timeout in seconds (default: 30)
 *   CRABTALK_HOST           - CrabTalk TCP host (default: 127.0.0.1)
 *   CRABTALK_PORT           - CrabTalk TCP port (default: 6688)
 */

import net from "node:net";
import { crabtalk } from "../proto/crabtalk.js";

const { ClientMessage, ServerMessage, AgentEventKind } = crabtalk.protocol;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN || BOT_TOKEN === "CHANGE_ME") {
  console.log("[telegram-bridge] TELEGRAM_BOT_TOKEN not set, exiting");
  process.exit(0);
}

const POLL_TIMEOUT = parseInt(process.env.TELEGRAM_POLL_TIMEOUT || "30", 10);
const CT_HOST = process.env.CRABTALK_HOST || "127.0.0.1";
const CT_PORT = parseInt(process.env.CRABTALK_PORT || "6688", 10);

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Per-chat session IDs (CrabTalk sessions keyed by Telegram chat ID)
const chatSessions = new Map(); // chatId -> sessionId (string)

// Active event subscriptions keyed by Telegram chat ID
const eventSubscriptions = new Map(); // chatId -> { subscriptionId, socket }

let offset = 0;
let running = true;

function log(level, msg, data) {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level,
      service: "telegram-bridge",
      message: msg,
      ...data,
    })
  );
}

// ── Telegram API helpers ──────────────────────────────────────────

async function tgRequest(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function getUpdates() {
  try {
    const res = await fetch(
      `${API}/getUpdates?offset=${offset}&timeout=${POLL_TIMEOUT}&allowed_updates=["message"]`,
      { signal: AbortSignal.timeout((POLL_TIMEOUT + 10) * 1000) }
    );
    const json = await res.json();
    return json.ok ? json.result : [];
  } catch (err) {
    if (err.name !== "AbortError") {
      log("error", "getUpdates failed", { error: err.message });
    }
    return [];
  }
}

async function sendMessage(chatId, text) {
  const MAX = 4000;
  for (let i = 0; i < text.length; i += MAX) {
    const chunk = text.substring(i, i + MAX);
    const res = await tgRequest("sendMessage", {
      chat_id: chatId,
      text: chunk,
      parse_mode: "Markdown",
    });
    if (!res.ok && res.error_code === 400) {
      await tgRequest("sendMessage", { chat_id: chatId, text: chunk });
    }
  }
}

async function sendTyping(chatId) {
  await tgRequest("sendChatAction", {
    chat_id: chatId,
    action: "typing",
  }).catch(() => {});
}

// ── CrabTalk helpers ──────────────────────────────────────────────

/** Encode a ClientMessage as a length-prefixed buffer ready to write to a socket. */
function encodeMessage(message) {
  const encoded = ClientMessage.encode(message).finish();
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(encoded.length, 0);
  return Buffer.concat([lengthBuf, encoded]);
}

// ── CrabTalk TCP communication ────────────────────────────────────

/**
 * Send a SendMsg to CrabTalk followed by a SubscribeEventMsg, then stream
 * AgentEventMsg responses back via onEvent(AgentEventMsg).
 *
 * Resolves when AgentEventKind.DONE is received or the socket closes.
 * Rejects on connection/protocol errors.
 *
 * Returns a cleanup function that unsubscribes and closes the socket.
 */
function sendToCrabTalkStreaming(sendMessage, subscribeMessage, onEvent, onSubscription) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(CT_PORT, CT_HOST);

    let responseBuf = Buffer.alloc(0);
    let done = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };

    socket.on("connect", () => {
      // Send SendMsg then SubscribeEventMsg on the same connection
      socket.write(encodeMessage(sendMessage));
      socket.write(encodeMessage(subscribeMessage));
    });

    socket.on("data", (chunk) => {
      responseBuf = Buffer.concat([responseBuf, chunk]);

      // Parse length-prefixed protobuf messages
      while (responseBuf.length >= 4) {
        const msgLen = responseBuf.readUInt32BE(0);
        if (responseBuf.length < 4 + msgLen) break;

        const msgBuf = responseBuf.subarray(4, 4 + msgLen);
        responseBuf = responseBuf.subarray(4 + msgLen);

        try {
          const serverMsg = ServerMessage.decode(msgBuf);

          // Subscription confirmation — capture the subscription ID
          if (serverMsg.subscriptionInfo) {
            onSubscription(serverMsg.subscriptionInfo.id, socket);
          }

          // Primary path: AgentEventMsg stream
          if (serverMsg.agentEvent) {
            const event = serverMsg.agentEvent;
            onEvent(event);
            if (event.kind === AgentEventKind.DONE) {
              finish();
              return;
            }
          }

          // Fallback: StreamEvent (chunk/end) for backward compatibility
          if (serverMsg.stream) {
            const streamEvent = serverMsg.stream;
            if (streamEvent.chunk) {
              onEvent({ kind: AgentEventKind.TEXT_DELTA, content: streamEvent.chunk.content || "" });
            }
            if (streamEvent.end) {
              finish();
              return;
            }
          }

          if (serverMsg.error) {
            finish(new Error(serverMsg.error.message || "CrabTalk error"));
            return;
          }
        } catch (e) {
          // Skip unparseable messages
        }
      }
    });

    socket.on("error", (err) => {
      finish(err);
    });

    socket.on("close", () => {
      finish();
    });

    // Timeout after 2 minutes
    setTimeout(() => finish(), 120000);
  });
}

/**
 * If there is an active event subscription for chatId, send UnsubscribeEventMsg
 * and destroy the socket, then remove from the map.
 */
function clearSubscription(chatId) {
  const sub = eventSubscriptions.get(chatId);
  if (!sub) return;
  eventSubscriptions.delete(chatId);

  const { subscriptionId, socket } = sub;
  if (subscriptionId && !socket.destroyed) {
    try {
      socket.write(
        encodeMessage(
          ClientMessage.create({ unsubscribeEvent: { id: subscriptionId } })
        )
      );
    } catch (_) {
      // best-effort
    }
  }
  socket.destroy();
}

// ── Handle incoming message ──────────────────────────────────────

async function handleMessage(chatId, text) {
  await sendTyping(chatId);

  const typingInterval = setInterval(() => sendTyping(chatId), 4000);

  try {
    const sessionId = chatSessions.get(chatId) || `telegram-${chatId}`;
    chatSessions.set(chatId, sessionId);

    const sendMsg = ClientMessage.create({
      send: {
        content: text,
        sender: sessionId,
        agent: "crabcode",
      },
    });

    const subscribeMsg = ClientMessage.create({
      subscribeEvent: {
        source: "crabcode",
        target_agent: "telegram",
        once: false,
      },
    });

    let accumulatedText = "";

    await sendToCrabTalkStreaming(
      sendMsg,
      subscribeMsg,
      (event) => {
        switch (event.kind) {
          case AgentEventKind.TEXT_DELTA:
            accumulatedText += event.content || "";
            break;
          // THINKING_*, TOOL_*, DONE handled implicitly (DONE triggers finish)
        }
      },
      (subscriptionId, socket) => {
        // Store subscription so /start can cancel it
        eventSubscriptions.set(chatId, { subscriptionId, socket });
        log("debug", "event subscription registered", { chatId, subscriptionId });
      }
    );

    // Subscription is done after DONE — clean up the map entry
    eventSubscriptions.delete(chatId);

    const response = accumulatedText.trim() || "No response from agent.";
    await sendMessage(chatId, response);
  } catch (err) {
    log("error", "CrabTalk request failed", { error: err.message });
    clearSubscription(chatId);
    await sendMessage(chatId, "Sorry, the agent is currently unavailable.");
  } finally {
    clearInterval(typingInterval);
  }
}

// ── Main polling loop ─────────────────────────────────────────────

async function main() {
  const me = await tgRequest("getMe", {});
  if (!me.ok) {
    log("error", "Invalid bot token", { result: me });
    process.exit(1);
  }
  log("info", `Telegram bot started: @${me.result.username}`, {
    bot_id: me.result.id,
  });

  while (running) {
    const updates = await getUpdates();

    for (const update of updates) {
      offset = update.update_id + 1;

      const msg = update.message;
      if (!msg || !msg.text) continue;

      const chatId = msg.chat.id;
      const cleanText = msg.text.replace(/@\S+/g, "").trim();

      if (!cleanText || cleanText === "/start") {
        if (cleanText === "/start") {
          // Clear session and any active event subscription
          chatSessions.delete(chatId);
          clearSubscription(chatId);
          await sendMessage(
            chatId,
            "Hello! I'm CrabCode, your AI coding agent. Send me a ticket ID or a coding task and I'll get to work."
          );
        }
        continue;
      }

      handleMessage(chatId, cleanText).catch((err) => {
        log("error", "handleMessage failed", { error: err.message, chatId });
      });
    }
  }
}

process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

main().catch((err) => {
  log("error", "Fatal error", { error: err.message, stack: err.stack });
  process.exit(1);
});
