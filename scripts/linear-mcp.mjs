#!/usr/bin/env node
/**
 * linear-mcp.mjs — Minimal Linear MCP server using direct GraphQL calls.
 *
 * Avoids @linear/sdk entirely to prevent its internal rate-limit queue
 * from deadlocking when multiple requests are issued concurrently at startup.
 *
 * Implements the MCP stdio transport (newline-delimited JSON-RPC 2.0).
 * Exposes: create_issue, update_issue, search_issues, get_user_issues, add_comment
 */

import { createInterface } from "readline";

const LINEAR_API = "https://api.linear.app/graphql";
const API_KEY = process.env.LINEAR_API_KEY;

if (!API_KEY) {
  process.stderr.write("[linear-mcp] ERROR: LINEAR_API_KEY is not set\n");
  process.exit(1);
}

// ── GraphQL helper ────────────────────────────────────────────────────────────

async function gql(query, variables = {}) {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Linear API HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  return json.data;
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function createIssue({ title, teamId, description, priority, status }) {
  const data = await gql(
    `mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { id identifier url title } }
    }`,
    { input: { title, teamId, description, priority, stateId: status } }
  );
  const issue = data.issueCreate.issue;
  return `Created issue ${issue.identifier}: ${issue.title}\nURL: ${issue.url}`;
}

async function updateIssue({ id, title, description, priority, status }) {
  const input = {};
  if (title !== undefined) input.title = title;
  if (description !== undefined) input.description = description;
  if (priority !== undefined) input.priority = priority;
  if (status !== undefined) input.stateId = status;

  const data = await gql(
    `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success issue { id identifier url title } }
    }`,
    { id, input }
  );
  const issue = data.issueUpdate.issue;
  return `Updated issue ${issue.identifier}: ${issue.title}\nURL: ${issue.url}`;
}

async function searchIssues({
  query,
  teamId,
  status,
  assigneeId,
  labels,
  priority,
  estimate,
  includeArchived,
  limit = 10,
}) {
  const filter = {};
  if (teamId) filter.team = { id: { eq: teamId } };
  if (status) filter.state = { name: { eq: status } };
  if (assigneeId) filter.assignee = { id: { eq: assigneeId } };
  if (priority) filter.priority = { eq: priority };
  if (estimate !== undefined) filter.estimate = { eq: estimate };
  if (labels?.length) filter.labels = { name: { in: labels } };

  const data = await gql(
    `query SearchIssues($filter: IssueFilter, $first: Int, $includeArchived: Boolean) {
      issues(filter: $filter, first: $first, includeArchived: $includeArchived) {
        nodes {
          id identifier title description priority url
          state { name }
          assignee { displayName }
          team { name }
          labels { nodes { name } }
        }
      }
    }`,
    { filter, first: limit, includeArchived: includeArchived ?? false }
  );

  const issues = data.issues.nodes;
  if (!issues.length) return "No issues found.";

  // If a text query was provided, do client-side filtering (Linear GraphQL
  // filter doesn't support full-text search via the filter arg cleanly).
  const filtered = query
    ? issues.filter(
        (i) =>
          i.title?.toLowerCase().includes(query.toLowerCase()) ||
          i.description?.toLowerCase().includes(query.toLowerCase())
      )
    : issues;

  if (!filtered.length) return "No issues matching query.";

  return filtered
    .map(
      (i) =>
        `[${i.identifier}] ${i.title}\n` +
        `  Status: ${i.state?.name ?? "—"}  Priority: ${i.priority ?? "—"}  ` +
        `Assignee: ${i.assignee?.displayName ?? "—"}  Team: ${i.team?.name ?? "—"}\n` +
        `  URL: ${i.url}`
    )
    .join("\n\n");
}

async function getUserIssues({ userId, includeArchived, limit = 50 }) {
  const filter = userId
    ? { assignee: { id: { eq: userId } } }
    : { assignee: { isMe: { eq: true } } };

  const data = await gql(
    `query GetUserIssues($filter: IssueFilter, $first: Int, $includeArchived: Boolean) {
      issues(filter: $filter, first: $first, includeArchived: $includeArchived, orderBy: updatedAt) {
        nodes {
          id identifier title priority url updatedAt
          state { name }
          team { name }
        }
      }
    }`,
    { filter, first: limit, includeArchived: includeArchived ?? false }
  );

  const issues = data.issues.nodes;
  if (!issues.length) return "No issues found.";

  return issues
    .map(
      (i) =>
        `[${i.identifier}] ${i.title}\n` +
        `  Status: ${i.state?.name ?? "—"}  Priority: ${i.priority ?? "—"}  Team: ${i.team?.name ?? "—"}\n` +
        `  URL: ${i.url}`
    )
    .join("\n\n");
}

async function addComment({ issueId, body, createAsUser, displayIconUrl }) {
  const data = await gql(
    `mutation AddComment($input: CommentCreateInput!) {
      commentCreate(input: $input) { success comment { id url } }
    }`,
    {
      input: {
        issueId,
        body,
        ...(createAsUser ? { createAsUser } : {}),
        ...(displayIconUrl ? { displayIconUrl } : {}),
      },
    }
  );
  return `Comment added: ${data.commentCreate.comment.url}`;
}

// ── MCP tool registry ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "linear_create_issue",
    description:
      "Creates a new Linear issue. Returns the created issue's identifier and URL.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Issue title" },
        teamId: { type: "string", description: "Team ID" },
        description: { type: "string", description: "Issue description" },
        priority: { type: "number", description: "Priority (0-4)" },
        status: { type: "string", description: "Issue status" },
      },
      required: ["title", "teamId"],
    },
  },
  {
    name: "linear_update_issue",
    description:
      "Updates an existing Linear issue. Requires the issue ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Issue ID" },
        title: { type: "string", description: "New title" },
        description: { type: "string", description: "New description" },
        priority: { type: "number", description: "New priority (0-4)" },
        status: { type: "string", description: "New status" },
      },
      required: ["id"],
    },
  },
  {
    name: "linear_search_issues",
    description:
      "Searches Linear issues by text query and/or filters (team, status, assignee, labels, priority).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search in title/description" },
        teamId: { type: "string", description: "Filter by team ID" },
        status: { type: "string", description: "Filter by status name" },
        assigneeId: { type: "string", description: "Filter by assignee user ID" },
        labels: { type: "array", items: { type: "string" }, description: "Filter by label names" },
        priority: { type: "number", description: "Filter by priority (1=urgent, 2=high, 3=normal, 4=low)" },
        estimate: { type: "number", description: "Filter by estimate points" },
        includeArchived: { type: "boolean", description: "Include archived issues" },
        limit: { type: "number", description: "Max results (default: 10)" },
      },
    },
  },
  {
    name: "linear_get_user_issues",
    description:
      "Retrieves issues assigned to a user (or the authenticated user if no userId).",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "User ID (omit for self)" },
        includeArchived: { type: "boolean", description: "Include archived issues" },
        limit: { type: "number", description: "Max results (default: 50)" },
      },
    },
  },
  {
    name: "linear_add_comment",
    description: "Adds a markdown comment to a Linear issue.",
    inputSchema: {
      type: "object",
      properties: {
        issueId: { type: "string", description: "Issue ID" },
        body: { type: "string", description: "Comment text (markdown)" },
        createAsUser: { type: "string", description: "Custom username for comment" },
        displayIconUrl: { type: "string", description: "Avatar URL for comment" },
      },
      required: ["issueId", "body"],
    },
  },
];

const TOOL_HANDLERS = {
  linear_create_issue: createIssue,
  linear_update_issue: updateIssue,
  linear_search_issues: searchIssues,
  linear_get_user_issues: getUserIssues,
  linear_add_comment: addComment,
};

// ── MCP stdio transport ───────────────────────────────────────────────────────

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const rl = createInterface({ input: process.stdin, terminal: false });

let pending = 0;
let stdinClosed = false;

function tryExit() {
  if (stdinClosed && pending === 0) process.exit(0);
}

process.stderr.write("[linear-mcp] Starting Linear MCP server (direct GraphQL)\n");

rl.on("line", async (line) => {
  pending++;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = msg;

  try {
    switch (method) {
      case "initialize":
        respond(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "linear-mcp", version: "1.0.0" },
        });
        break;

      case "notifications/initialized":
        break;

      case "tools/list":
        respond(id, { tools: TOOLS });
        break;

      case "tools/call": {
        const { name, arguments: args } = params;
        const handler = TOOL_HANDLERS[name];
        if (!handler) {
          error(id, -32601, `Unknown tool: ${name}`);
          break;
        }
        const text = await handler(args ?? {});
        respond(id, { content: [{ type: "text", text }] });
        break;
      }

      default:
        // Ignore unknown methods (notifications etc.)
        if (id !== undefined) {
          error(id, -32601, `Method not found: ${method}`);
        }
    }
  } catch (err) {
    process.stderr.write(`[linear-mcp] Error handling ${method}: ${err.message}\n`);
    if (id !== undefined) {
      error(id, -32603, err.message);
    }
  } finally {
    pending--;
    tryExit();
  }
});

rl.on("close", () => {
  stdinClosed = true;
  tryExit();
});
