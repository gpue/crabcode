/**
 * linear-agent.mjs
 *
 * Watches Linear for tickets assigned to the bot and dispatches them
 * to CrabTalk for autonomous coding via OpenCode.
 *
 * Environment variables:
 *   LINEAR_API_KEY          - Linear API key (required)
 *   LINEAR_TEAM_ID          - Linear team ID to watch (optional, watches all if unset)
 *   LINEAR_ASSIGNEE_ID      - Linear user ID of the bot account (required for filtering)
 *   LINEAR_POLL_INTERVAL_MS - Poll interval in ms (default: 30000)
 *   OPENCODE_MCP_URL        - OpenCode MCP bridge URL (default: http://127.0.0.1:8081)
 */

const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
if (!LINEAR_API_KEY) {
  console.log("[linear-agent] LINEAR_API_KEY not set, exiting");
  process.exit(0);
}

const LINEAR_ASSIGNEE_ID = process.env.LINEAR_ASSIGNEE_ID || "";
const LINEAR_TEAM_ID = process.env.LINEAR_TEAM_ID || "";
const POLL_INTERVAL = parseInt(process.env.LINEAR_POLL_INTERVAL_MS || "30000", 10);
const OPENCODE_URL = process.env.OPENCODE_MCP_URL || "http://127.0.0.1:8081";

const processedTickets = new Set();
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

async function fetchAssignedTickets() {
  const filter = {};
  if (LINEAR_ASSIGNEE_ID) filter.assignee = { id: { eq: LINEAR_ASSIGNEE_ID } };
  if (LINEAR_TEAM_ID) filter.team = { id: { eq: LINEAR_TEAM_ID } };
  // Only fetch "In Progress" or "Todo" tickets
  filter.state = { type: { in: ["started", "unstarted"] } };

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
        }
      }
    }`,
    { filter }
  );
  return data.issues.nodes;
}

async function updateTicketState(issueId, stateType) {
  // Find the target state ID
  const data = await linearQuery(
    `query($issueId: String!) {
      issue(id: $issueId) {
        team {
          states { nodes { id name type } }
        }
      }
    }`,
    { issueId }
  );
  const states = data.issue.team.states.nodes;
  const targetState = states.find((s) => s.type === stateType);
  if (!targetState) return;

  await linearQuery(
    `mutation($issueId: String!, $stateId: String!) {
      issueUpdate(id: $issueId, input: { stateId: $stateId }) {
        issue { id state { name } }
      }
    }`,
    { issueId, stateId: targetState.id }
  );
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
  const data = await res.json();
  return data.id;
}

async function sendPromptToSession(sessionId, prompt, providerID, modelID) {
  await fetch(`${OPENCODE_URL}/session/${sessionId}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      providerID: providerID || "copilot",
      modelID: modelID || "claude-sonnet-4",
      variant: "medium",
      mode: "code",
    }),
  });
}

// ── Ticket processing ───────────────────────────────────────────

async function processTicket(ticket) {
  log("info", `Processing ticket ${ticket.identifier}: ${ticket.title}`, {
    ticketId: ticket.id,
  });

  try {
    // Move to "In Progress"
    await updateTicketState(ticket.id, "started");

    // Create OpenCode session
    const sessionId = await createOpenCodeSession();
    log("info", `Created OpenCode session ${sessionId} for ${ticket.identifier}`);

    // Build prompt from ticket
    const prompt = [
      `## Linear Ticket: ${ticket.identifier} — ${ticket.title}`,
      "",
      ticket.description || "No description provided.",
      "",
      `Ticket URL: ${ticket.url}`,
      "",
      "Please implement the changes described above. Follow existing code patterns,",
      "write tests if applicable, and commit with a message referencing the ticket.",
    ].join("\n");

    // Send to OpenCode
    await sendPromptToSession(sessionId, prompt);

    // Add comment to Linear
    await addComment(
      ticket.id,
      `🤖 CrabCode is working on this ticket.\nOpenCode session: \`${sessionId}\``
    );

    log("info", `Dispatched ${ticket.identifier} to OpenCode session ${sessionId}`);
  } catch (err) {
    log("error", `Failed to process ticket ${ticket.identifier}`, {
      error: err.message,
    });
    try {
      await addComment(
        ticket.id,
        `🤖 CrabCode failed to start: ${err.message}`
      );
    } catch {}
  }
}

// ── Main poll loop ──────────────────────────────────────────────

async function main() {
  log("info", "Linear agent started", {
    assignee: LINEAR_ASSIGNEE_ID || "(all)",
    team: LINEAR_TEAM_ID || "(all)",
    pollInterval: POLL_INTERVAL,
  });

  while (running) {
    try {
      const tickets = await fetchAssignedTickets();

      for (const ticket of tickets) {
        if (processedTickets.has(ticket.id)) continue;

        // Check if ticket has a label like "crabcode" or "bot"
        const labels = (ticket.labels?.nodes || []).map((l) =>
          l.name.toLowerCase()
        );
        const shouldProcess =
          labels.includes("crabcode") ||
          labels.includes("bot") ||
          labels.includes("automate");

        if (shouldProcess) {
          processedTickets.add(ticket.id);
          processTicket(ticket).catch((err) => {
            log("error", `Unhandled error processing ${ticket.identifier}`, {
              error: err.message,
            });
          });
        }
      }
    } catch (err) {
      log("error", "Poll cycle failed", { error: err.message });
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

main().catch((err) => {
  log("error", "Fatal error", { error: err.message, stack: err.stack });
  process.exit(1);
});
