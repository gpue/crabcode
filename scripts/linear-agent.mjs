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

async function moveTicketToState(issueId, stateType) {
  const states = await getWorkflowStates(issueId);
  const target = states.find((s) => s.type === stateType);
  if (!target) {
    log("warn", `No state of type '${stateType}' found`, { issueId });
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

async function createOpenCodeSession() {
  const res = await fetch(`${OPENCODE_URL}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lane: "now" }),
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
      providerID: "copilot",
      modelID: "claude-sonnet-4",
      variant: "medium",
      mode: "code",
    }),
  });
  if (!res.ok) throw new Error(`Failed to send prompt: ${res.status}`);
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

async function startTicket(ticket) {
  const ticketRef = `${ticket.identifier}: ${ticket.title}`;
  log("info", `Starting work on ${ticketRef}`, { ticketId: ticket.id });

  try {
    // 1. Move to "In Progress"
    await moveTicketToState(ticket.id, "started");

    // 2. Comment that we're starting
    await addComment(
      ticket.id,
      `🦀 **crab** is picking up this ticket.\n\nAnalyzing the requirements and starting implementation...`
    );

    // 3. Create OpenCode session
    const sessionId = await createOpenCodeSession();
    log("info", `Created OpenCode session ${sessionId} for ${ticket.identifier}`);

    // 4. Build prompt from ticket
    const prompt = buildPrompt(ticket);

    // 5. Send to OpenCode
    await sendPromptToSession(sessionId, prompt);

    // 6. Track active ticket
    activeTickets.set(ticket.id, {
      sessionId,
      identifier: ticket.identifier,
      title: ticket.title,
      startedAt: Date.now(),
      lastChecked: Date.now(),
    });

    // 7. Comment with session link
    await addComment(
      ticket.id,
      `🔧 OpenCode session \`${sessionId}\` created. Working on implementation...`
    );
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

function buildPrompt(ticket) {
  const parts = [
    `## Linear Ticket: ${ticket.identifier} — ${ticket.title}`,
    "",
  ];

  if (ticket.description) {
    parts.push(ticket.description);
  } else {
    parts.push("No description provided.");
  }

  parts.push("");
  parts.push(`Ticket URL: ${ticket.url}`);
  parts.push("");

  // Include recent comments for context
  const comments = ticket.comments?.nodes || [];
  if (comments.length > 0) {
    parts.push("### Recent comments:");
    for (const c of comments) {
      if (c.user?.name === "crab") continue; // skip our own comments
      parts.push(`- **${c.user?.name || "Unknown"}**: ${c.body.substring(0, 200)}`);
    }
    parts.push("");
  }

  parts.push(
    "Please implement the changes described above. Follow existing code patterns,",
    "write tests if applicable, and commit with a message referencing the ticket.",
    "",
    "When done, provide a brief summary of what was changed and any follow-up items.",
    "If you have questions or are blocked, clearly state what information you need."
  );

  return parts.join("\n");
}

// ── Session monitoring ──────────────────────────────────────────

async function checkActiveTickets() {
  for (const [ticketId, info] of activeTickets) {
    try {
      const session = await getSessionStatus(info.sessionId);
      if (!session) continue;

      const elapsed = Date.now() - info.startedAt;
      const elapsedMin = Math.round(elapsed / 60000);

      // Check if session is complete (has a final response)
      if (session.status === "completed" || session.status === "idle") {
        const summary = session.lastResponse?.substring(0, 500) || "Work completed.";

        await addComment(
          ticketId,
          `✅ **crab** has finished working on this ticket (${elapsedMin}min).\n\n${summary}`
        );
        await moveTicketToState(ticketId, "completed");

        activeTickets.delete(ticketId);
        finishedTickets.add(ticketId);
        log("info", `Completed ${info.identifier}`, { elapsed: elapsedMin });
      } else if (session.status === "error") {
        const errorMsg = session.error || "Unknown error";

        await addComment(
          ticketId,
          `❌ **crab** encountered an error:\n\n\`\`\`\n${errorMsg}\n\`\`\`\n\nThe ticket may need manual attention.`
        );

        activeTickets.delete(ticketId);
        finishedTickets.add(ticketId);
        log("error", `Error on ${info.identifier}`, { error: errorMsg });
      }

      // Timeout after 30 minutes
      if (elapsed > 30 * 60 * 1000 && !finishedTickets.has(ticketId)) {
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

        // Start working on the ticket
        startTicket(ticket).catch((err) => {
          log("error", `Unhandled error starting ${ticket.identifier}`, {
            error: err.message,
          });
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
