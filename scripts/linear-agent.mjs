/**
 * linear-agent.mjs
 *
 * Watches Linear for tickets assigned to the "crab" user and dispatches them
 * to CrabTalk for autonomous coding via OpenCode.
 *
 * Workflow:
 *   1. Polls Linear for tickets assigned to "crab" (by name or ID)
 *   2. When a new ticket is found:
 *      a. Moves ticket to "In Progress"
 *      b. Comments that crab is starting work
 *      c. Creates an OpenCode session and sends the ticket as a prompt
 *   3. Monitors the OpenCode session for completion
 *   4. On completion: moves ticket to "Done", comments with summary
 *   5. On failure/questions: comments with details, optionally moves to "Blocked"
 *
 * Environment variables:
 *   LINEAR_API_KEY          - Linear API key (required)
 *   LINEAR_CRAB_USER_NAME   - Name of the crab user to match (default: "crab")
 *   LINEAR_CRAB_USER_ID     - Direct user ID override (optional, skips name lookup)
 *   LINEAR_TEAM_ID          - Linear team ID to watch (optional, watches all if unset)
 *   LINEAR_POLL_INTERVAL_MS - Poll interval in ms (default: 30000)
 *   OPENCODE_MCP_URL        - OpenCode MCP bridge URL (default: http://127.0.0.1:8081)
 */
// version: 2

const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
if (!LINEAR_API_KEY) {
  console.log("[linear-agent] LINEAR_API_KEY not set, exiting");
  process.exit(0);
}

const CRAB_USER_NAME = (process.env.LINEAR_CRAB_USER_NAME || "crab").toLowerCase();
const CRAB_USER_ID_OVERRIDE = process.env.LINEAR_CRAB_USER_ID || "";
const LINEAR_TEAM_ID = process.env.LINEAR_TEAM_ID || "";
const POLL_INTERVAL = parseInt(process.env.LINEAR_POLL_INTERVAL_MS || "30000", 10);
const OPENCODE_URL = process.env.OPENCODE_MCP_URL || "http://127.0.0.1:8081";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_NOTIFY_TARGET || "";

// ── Project → repo routing ──────────────────────────────────────
// Maps Linear project name (lowercased) to workspace repo path.
// Add entries here as new projects/repos are created.
const PROJECT_REPO_MAP = {
  "crabcode": "/workspace/crabcode",
  "formfactors": "/workspace/formfactors",
};
const DEFAULT_REPO = "/workspace/crabcode";

// Tickets currently being processed (id → { sessionId, startedAt })
const activeTickets = new Map();
// Tickets we've already completed or failed
const finishedTickets = new Set();

let crabUserId = CRAB_USER_ID_OVERRIDE;
let running = true;

function log(level, msg, data) {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level,
      service: "linear-agent",
      message: msg,
      ...data,
    })
  );
}

// ── Telegram notifications ───────────────────────────────────────

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" }),
    });
  } catch (err) {
    log("warn", `Telegram notification failed: ${err.message}`);
  }
}

// ── CrabTalk TCP helper (for classification) ─────────────────────

import net from "node:net";
import { crabtalk } from "../proto/crabtalk.js";

const { ClientMessage, ServerMessage, AgentEventKind } = crabtalk.protocol;
const CT_HOST = process.env.CRABTALK_HOST || "127.0.0.1";
const CT_PORT = parseInt(process.env.CRABTALK_PORT || "6688", 10);

function encodeCTMessage(message) {
  const encoded = ClientMessage.encode(message).finish();
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(encoded.length, 0);
  return Buffer.concat([lengthBuf, encoded]);
}

/**
 * Send a short prompt to CrabTalk and return the text response.
 * Used for lightweight classification without creating an OpenCode session.
 */
function askCrabTalk(prompt, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(CT_PORT, CT_HOST);
    let buf = Buffer.alloc(0);
    let text = "";
    let done = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(text.trim());
    };

    socket.on("connect", () => {
      socket.write(encodeCTMessage(ClientMessage.create({ subscribeEvents: {} })));
      socket.write(encodeCTMessage(ClientMessage.create({
        send: { content: prompt, sender: "linear-agent-classify", agent: "crabcode" },
      })));
    });

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        const m = ServerMessage.decode(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
        if (m.agentEvent) {
          if (m.agentEvent.kind === AgentEventKind.TEXT_DELTA) text += m.agentEvent.content || "";
          if (m.agentEvent.kind === AgentEventKind.DONE) { finish(); return; }
        }
        if (m.error) { finish(new Error(m.error.message || "CrabTalk error")); return; }
      }
    });

    socket.on("error", finish);
    socket.on("close", () => finish());
    setTimeout(() => finish(new Error("CrabTalk classification timeout")), timeoutMs);
  });
}

// ── Linear GraphQL API ──────────────────────────────────────────

async function linearQuery(query, variables = {}) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: LINEAR_API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(json.errors.map((e) => e.message).join(", "));
  }
  return json.data;
}

async function resolveCrabUserId() {
  if (crabUserId) return crabUserId;

  const data = await linearQuery(`{
    users { nodes { id name displayName active } }
  }`);

  const user = data.users.nodes.find(
    (u) =>
      u.active &&
      (u.name.toLowerCase().includes(CRAB_USER_NAME) ||
        u.displayName.toLowerCase().includes(CRAB_USER_NAME))
  );

  if (user) {
    crabUserId = user.id;
    log("info", `Resolved crab user: ${user.name} (${user.id})`);
  } else {
    log("warn", `No user matching '${CRAB_USER_NAME}' found, will retry next cycle`);
  }

  return crabUserId;
}

async function fetchCrabTickets(userId) {
  const filter = {
    assignee: { id: { eq: userId } },
    state: { type: { in: ["started", "unstarted"] } },
  };
  if (LINEAR_TEAM_ID) filter.team = { id: { eq: LINEAR_TEAM_ID } };

  const data = await linearQuery(
    `query($filter: IssueFilter) {
      issues(filter: $filter, first: 20, orderBy: updatedAt) {
        nodes {
          id
          identifier
          title
          description
          state { name type }
          labels { nodes { name } }
          priority
          url
          project { id name }
          assignee { id name }
          comments(first: 5, orderBy: createdAt) {
            nodes { body createdAt user { name } }
          }
        }
      }
    }`,
    { filter }
  );
  return data.issues.nodes;
}

async function getWorkflowStates(issueId) {
  const data = await linearQuery(
    `query($issueId: String!) {
      issue(id: $issueId) {
        team { states { nodes { id name type } } }
      }
    }`,
    { issueId }
  );
  return data.issue.team.states.nodes;
}

async function moveTicketToState(issueId, stateName) {
  const states = await getWorkflowStates(issueId);
  // Match by exact name first (e.g. "In Progress"), then fall back to type
  const target =
    states.find((s) => s.name.toLowerCase() === stateName.toLowerCase()) ||
    states.find((s) => s.type === stateName);
  if (!target) {
    log("warn", `No state matching '${stateName}' found`, { issueId });
    return;
  }

  await linearQuery(
    `mutation($issueId: String!, $stateId: String!) {
      issueUpdate(id: $issueId, input: { stateId: $stateId }) {
        issue { id state { name } }
      }
    }`,
    { issueId, stateId: target.id }
  );
  log("info", `Moved ticket to ${target.name}`, { issueId, state: target.name });
}

async function addComment(issueId, body) {
  await linearQuery(
    `mutation($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        comment { id }
      }
    }`,
    { issueId, body }
  );
}

// ── OpenCode session management ─────────────────────────────────

async function createOpenCodeSession(title) {
  const res = await fetch(`${OPENCODE_URL}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lane: "now", title }),
  });
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
  const data = await res.json();
  return data.id;
}

async function sendPromptToSession(sessionId, prompt) {
  const res = await fetch(`${OPENCODE_URL}/session/${sessionId}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      providerID: "github-copilot",
      modelID: "claude-sonnet-4",
      variant: "medium",
      mode: "code",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to send prompt: ${res.status} ${body}`);
  }
}

async function getSessionStatus(sessionId) {
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${sessionId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── Ticket processing ───────────────────────────────────────────

/**
 * Resolve which repo path to work in for a given ticket.
 * 1. If the ticket has a Linear project whose name matches PROJECT_REPO_MAP → use it.
 * 2. Otherwise, ask the LLM to classify the ticket and parse the response.
 * 3. Fall back to DEFAULT_REPO if LLM response is unrecognisable.
 */
async function resolveRepo(ticket) {
  // 1. Static project map
  if (ticket.project?.name) {
    const key = ticket.project.name.toLowerCase();
    for (const [mapKey, repoPath] of Object.entries(PROJECT_REPO_MAP)) {
      if (key.includes(mapKey)) {
        log("info", `Routing ${ticket.identifier} to ${repoPath} via project '${ticket.project.name}'`);
        return repoPath;
      }
    }
  }

  // 2. CrabTalk LLM fallback
  const repoList = Object.entries(PROJECT_REPO_MAP)
    .map(([name, path]) => `- ${name}: ${path}`)
    .join("\n");

  const classifyPrompt = `Given these repositories:\n${repoList}\n\nWhich repository does this ticket belong to? Reply with ONLY the repository name (e.g. "crabcode" or "formfactors"), nothing else.\n\nTicket title: ${ticket.title}\nTicket description: ${(ticket.description || "").substring(0, 300)}`;

  try {
    const reply = await askCrabTalk(classifyPrompt);
    const replyLower = reply.toLowerCase();

    for (const [mapKey, repoPath] of Object.entries(PROJECT_REPO_MAP)) {
      if (replyLower.includes(mapKey)) {
        log("info", `CrabTalk classified ${ticket.identifier} → ${repoPath}`);
        return repoPath;
      }
    }

    log("warn", `CrabTalk classification unclear for ${ticket.identifier}, reply: '${reply}'. Using default.`);
  } catch (err) {
    log("warn", `CrabTalk classification failed for ${ticket.identifier}: ${err.message}. Using default.`);
  }

  // 3. Default
  return DEFAULT_REPO;
}

async function startTicket(ticket) {
  const ticketRef = `${ticket.identifier}: ${ticket.title}`;
  log("info", `Starting work on ${ticketRef}`, { ticketId: ticket.id });

  try {
    // 0. Resolve target repo
    const repoPath = await resolveRepo(ticket);
    log("info", `Target repo for ${ticket.identifier}: ${repoPath}`);

    // 1. Move to "In Progress"
    await moveTicketToState(ticket.id, "In Progress");

    // 2. Comment that we're starting
    await addComment(
      ticket.id,
      `🦀 **crab** is picking up this ticket.\n\nAnalyzing the requirements and starting implementation...`
    );

    // 3. Create OpenCode session
    const sessionId = await createOpenCodeSession(`${ticket.identifier}: ${ticket.title}`);
    log("info", `Created OpenCode session ${sessionId} for ${ticket.identifier}`);

    // 4. Build prompt from ticket
    const prompt = buildPrompt(ticket, repoPath);

    // 5. Send to OpenCode
    await sendPromptToSession(sessionId, prompt);

    // 6. Track active ticket
    activeTickets.set(ticket.id, {
      sessionId,
      identifier: ticket.identifier,
      title: ticket.title,
      startedAt: Date.now(),
      lastChecked: Date.now(),
      lastSeenCommentAt: new Date().toISOString(),
    });

    // 7. Comment with session link
    await addComment(
      ticket.id,
      `🔧 OpenCode session \`${sessionId}\` created. Working on implementation...`
    );

    // 8. Notify via Telegram
    await sendTelegram(`🦀 *Starting* [${ticket.identifier}](${ticket.url}): ${ticket.title}`);
  } catch (err) {
    log("error", `Failed to start ${ticketRef}`, { error: err.message });
    try {
      await addComment(
        ticket.id,
        `❌ **crab** failed to start work: ${err.message}\n\nPlease check the agent logs or reassign.`
      );
    } catch {}
  }
}

function buildPrompt(ticket, repoPath) {
  const parts = [
    `## Assigned Linear Ticket: ${ticket.identifier}`,
    "",
    `You have been assigned Linear ticket **${ticket.identifier}** ("${ticket.title}").`,
    "",
    "Use the Linear MCP tools to retrieve the full ticket details, description, and comments:",
    `- Call \`linear_get_issue\` with id \`${ticket.identifier}\` to get the full description and metadata.`,
    `- Call \`linear_get_issue_comments\` with id \`${ticket.identifier}\` to read all comments.`,
    "",
    "Based on the ticket information, implement the requested changes.",
    "",
  ];

  if (repoPath) {
    parts.push(`**Work in the repository at \`${repoPath}\`.**`);
    parts.push("");
  }

  parts.push(
    "Follow existing code patterns, write tests if applicable,",
    "and commit with a message referencing the ticket.",
    "",
    "When done, add a comment to the Linear ticket summarizing what was changed",
    `(use \`linear_add_comment\` with issueId \`${ticket.identifier}\`).`,
    "",
    "If you have questions or are blocked, comment on the ticket asking for clarification."
  );

  return parts.join("\n");
}

/**
 * Build a follow-up prompt when a new comment arrives on an active ticket.
 */
function buildCommentPrompt(ticket, comment) {
  return [
    `## New comment on ${ticket.identifier}`,
    "",
    `**${comment.user?.name || "Someone"}** commented on your active ticket **${ticket.identifier}**:`,
    "",
    `> ${comment.body}`,
    "",
    "Use the Linear MCP tools to review the full context if needed:",
    `- \`linear_get_issue\` with id \`${ticket.identifier}\``,
    `- \`linear_get_issue_comments\` with id \`${ticket.identifier}\``,
    "",
    "Respond to this comment by continuing your work or replying on the ticket.",
  ].join("\n");
}

// ── Session monitoring ──────────────────────────────────────────

async function fetchTicketComments(ticketId) {
  const data = await linearQuery(
    `query($id: String!) {
      issue(id: $id) {
        comments(orderBy: createdAt) {
          nodes { id body createdAt user { id name } }
        }
      }
    }`,
    { id: ticketId }
  );
  return data.issue.comments.nodes;
}

/**
 * Check for new comments on active tickets and forward them as prompts.
 * Reuses the existing session; only creates a new one if the original is gone.
 */
async function checkNewComments() {
  for (const [ticketId, info] of activeTickets) {
    try {
      const comments = await fetchTicketComments(ticketId);
      const newComments = comments.filter(
        (c) =>
          c.createdAt > info.lastSeenCommentAt &&
          c.user?.id !== crabUserId // ignore our own comments
      );

      for (const comment of newComments) {
        log("info", `New comment on ${info.identifier} from ${comment.user?.name}`, {
          ticketId,
          commentId: comment.id,
        });

        const prompt = buildCommentPrompt(
          { identifier: info.identifier },
          comment
        );

        // Verify session still exists; recreate only if gone
        let sessionId = info.sessionId;
        if (sessionId) {
          const session = await getSessionStatus(sessionId);
          if (!session) {
            log("info", `Session ${sessionId} gone, creating new one for ${info.identifier}`);
            sessionId = await createOpenCodeSession(`${info.identifier}: ${info.title}`);
            info.sessionId = sessionId;
          }
        } else {
          sessionId = await createOpenCodeSession(`${info.identifier}: ${info.title}`);
          info.sessionId = sessionId;
        }

        try {
          await sendPromptToSession(sessionId, prompt);
          log("info", `Forwarded comment to session ${sessionId}`);
        } catch (err) {
          log("warn", `Failed to forward comment to session: ${err.message}`);
        }
      }

      // Update watermark
      if (comments.length > 0) {
        info.lastSeenCommentAt = comments[comments.length - 1].createdAt;
      }
    } catch (err) {
      log("error", `Error checking comments for ${info.identifier}`, {
        error: err.message,
      });
    }
  }
}

async function checkActiveTickets() {
  for (const [ticketId, info] of activeTickets) {
    try {
      const session = await getSessionStatus(info.sessionId);
      if (!session) continue;

      const elapsed = Date.now() - info.startedAt;
      const elapsedMin = Math.round(elapsed / 60000);

      // Session is done when running === false
      if (session.running === false) {
        // Extract last assistant text from messages
        const messages = session.messages || [];
        let summary = "Work completed.";
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m.info?.role === "assistant") {
            const text = (m.parts || []).find((p) => p.type === "text")?.text;
            if (text) {
              summary = text.substring(0, 1000);
              break;
            }
          }
        }

        await addComment(
          ticketId,
          `✅ **crab** has finished working on this ticket (${elapsedMin}min).\n\n${summary}`
        );
        await moveTicketToState(ticketId, "Done");
        await sendTelegram(`✅ *Done* ${info.identifier}: ${info.title} (${elapsedMin}min)`);

        activeTickets.delete(ticketId);
        finishedTickets.add(ticketId);
        log("info", `Completed ${info.identifier}`, { elapsed: elapsedMin });
        continue;
      }

      // Timeout after 30 minutes
      if (elapsed > 30 * 60 * 1000) {
        await addComment(
          ticketId,
          `⏰ **crab** has been working for ${elapsedMin}min without completing. Session: \`${info.sessionId}\`.\n\nThis may need manual review.`
        );
        activeTickets.delete(ticketId);
        finishedTickets.add(ticketId);
        log("warn", `Timeout on ${info.identifier}`, { elapsed: elapsedMin });
      }
    } catch (err) {
      log("error", `Error checking ${info.identifier}`, { error: err.message });
    }
  }
}

// ── Main poll loop ──────────────────────────────────────────────

async function main() {
  log("info", "Linear agent started", {
    crabUserName: CRAB_USER_NAME,
    crabUserId: crabUserId || "(will resolve by name)",
    team: LINEAR_TEAM_ID || "(all)",
    pollInterval: POLL_INTERVAL,
  });

  while (running) {
    try {
      // Resolve crab user ID if needed
      const userId = await resolveCrabUserId();
      if (!userId) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
        continue;
      }

      // Fetch tickets assigned to crab
      const tickets = await fetchCrabTickets(userId);

      for (const ticket of tickets) {
        // Skip already active or finished tickets
        if (activeTickets.has(ticket.id) || finishedTickets.has(ticket.id)) continue;

        // Mark as active immediately to prevent duplicate starts across poll cycles
        activeTickets.set(ticket.id, {
          sessionId: null,
          identifier: ticket.identifier,
          title: ticket.title,
          startedAt: Date.now(),
          lastChecked: Date.now(),
          lastSeenCommentAt: new Date().toISOString(),
        });

        // Start working on the ticket
        startTicket(ticket).catch((err) => {
          log("error", `Unhandled error starting ${ticket.identifier}`, {
            error: err.message,
          });
          // Remove from active so it can be retried next cycle
          activeTickets.delete(ticket.id);
        });
      }

      // Check progress on active tickets
      await checkActiveTickets();
    } catch (err) {
      log("error", "Poll cycle failed", { error: err.message });
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

process.on("SIGINT", () => {
  running = false;
});
process.on("SIGTERM", () => {
  running = false;
});

main().catch((err) => {
  log("error", "Fatal error", { error: err.message, stack: err.stack });
  process.exit(1);
});
