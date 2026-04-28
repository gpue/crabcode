#!/usr/bin/env node
/**
 * linear-mcp.mjs — Minimal Linear MCP server using direct GraphQL calls.
 *
 * Avoids @linear/sdk entirely to prevent its internal rate-limit queue
 * from deadlocking when multiple requests are issued concurrently at startup.
 *
 * Implements the MCP stdio transport (newline-delimited JSON-RPC 2.0).
 * Exposes: create_issue, update_issue, search_issues, get_user_issues, add_comment
 *
 * Environment variables:
 *   LINEAR_API_KEY  - Linear API key (required)
 *   LINEAR_TEAM_ID - Default team ID/key to use when not specified (optional)
 */

import { createInterface } from "readline";

const LINEAR_API = "https://api.linear.app/graphql";
const API_KEY = process.env.LINEAR_API_KEY;
const DEFAULT_TEAM_ID = process.env.LINEAR_TEAM_ID || "";

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
    const text = await res.text();
    throw new Error(`Linear API HTTP ${res.status}: ${text}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    const msg = json.errors.map((e) => e.message).join("; ");
    throw new Error(`Linear API error: ${msg}`);
  }
  return json.data;
}

// ── Team resolution (name/key → UUID) ────────────────────────────────────────

const teamCache = new Map(); // key/name → uuid

async function resolveTeamId(teamId) {
  if (!teamId) return teamId;
  // Already a UUID
  if (/^[0-9a-f-]{36}$/.test(teamId)) return teamId;
  // Check cache
  if (teamCache.has(teamId.toLowerCase())) return teamCache.get(teamId.toLowerCase());
  // Fetch all teams and populate cache
  const data = await gql(`{ teams { nodes { id name key } } }`);
  for (const t of data.teams.nodes) {
    teamCache.set(t.key.toLowerCase(), t.id);
    teamCache.set(t.name.toLowerCase(), t.id);
    teamCache.set(t.id.toLowerCase(), t.id);
  }
  const resolved = teamCache.get(teamId.toLowerCase());
  if (!resolved) throw new Error(`Team not found: "${teamId}". Available teams: ${[...new Set(data.teams.nodes.map(t => `${t.name} (${t.key})`))].join(", ")}`);
  return resolved;
}

// ── Issue identifier resolution (e.g. "CRB-10" → UUID) ───────────────────────

async function resolveIssueId(idOrIdentifier) {
  if (!idOrIdentifier) throw new Error("Issue ID or identifier is required.");
  // Already a UUID
  if (/^[0-9a-f-]{36}$/.test(idOrIdentifier)) return idOrIdentifier;
  // Treat as human identifier like "CRB-10"
  const data = await gql(
    `query ResolveIssue($id: String!) { issue(id: $id) { id } }`,
    { id: idOrIdentifier }
  );
  if (!data.issue) throw new Error(`Issue not found: "${idOrIdentifier}"`);
  return data.issue.id;
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function getIssue({ id }) {
  const data = await gql(
    `query GetIssue($id: String!) {
      issue(id: $id) {
        id identifier title description priority url
        createdAt updatedAt dueDate estimate
        state { name }
        assignee { displayName email }
        team { name key }
        labels { nodes { name } }
        parent { identifier title }
        comments(first: 25, orderBy: createdAt) {
          nodes {
            id createdAt
            user { displayName }
            body
          }
        }
      }
    }`,
    { id }
  );
  if (!data.issue) throw new Error(`Issue not found: "${id}"`);
  const i = data.issue;
  const lines = [
    `[${i.identifier}] ${i.title}`,
    `  Status:   ${i.state?.name ?? "—"}`,
    `  Priority: ${i.priority ?? "—"}`,
    `  Assignee: ${i.assignee ? `${i.assignee.displayName} <${i.assignee.email}>` : "—"}`,
    `  Team:     ${i.team ? `${i.team.name} (${i.team.key})` : "—"}`,
    `  Labels:   ${i.labels?.nodes?.map((l) => l.name).join(", ") || "—"}`,
    `  Estimate: ${i.estimate ?? "—"}`,
    `  Due:      ${i.dueDate ?? "—"}`,
    `  Parent:   ${i.parent ? `[${i.parent.identifier}] ${i.parent.title}` : "—"}`,
    `  Created:  ${i.createdAt}`,
    `  Updated:  ${i.updatedAt}`,
    `  URL:      ${i.url}`,
    ``,
    `## Description`,
    i.description || "(no description)",
  ];
  if (i.comments?.nodes?.length) {
    lines.push(``, `## Comments (${i.comments.nodes.length})`);
    for (const c of i.comments.nodes) {
      lines.push(``, `### ${c.user?.displayName ?? "unknown"} — ${c.createdAt}`, c.body);
    }
  }
  return lines.join("\n");
}

async function getIssueComments({ id, limit = 50 }) {
  const uuid = await resolveIssueId(id);
  const data = await gql(
    `query GetComments($id: String!, $first: Int!) {
      issue(id: $id) {
        identifier title
        comments(first: $first, orderBy: createdAt) {
          nodes {
            id createdAt
            user { displayName }
            body
          }
        }
      }
    }`,
    { id: uuid, first: limit }
  );
  if (!data.issue) throw new Error(`Issue not found: "${id}"`);
  const { identifier, title, comments } = data.issue;
  if (!comments.nodes.length) return `No comments on [${identifier}] ${title}`;
  return (
    `[${identifier}] ${title} — ${comments.nodes.length} comment(s)\n\n` +
    comments.nodes
      .map((c) => `### ${c.user?.displayName ?? "unknown"} — ${c.createdAt}\n${c.body}`)
      .join("\n\n")
  );
}

async function listTeams() {
  const data = await gql(`{ teams { nodes { id key name } } }`);
  return data.teams.nodes
    .map((t) => `${t.key}  ${t.name}  (${t.id})`)
    .join("\n");
}

async function listStates({ teamId }) {
  const resolvedTeamId = await resolveTeamId(teamId || DEFAULT_TEAM_ID);
  if (!resolvedTeamId) throw new Error("teamId is required.");
  const data = await gql(
    `query ListStates($teamId: String!) {
      team(id: $teamId) {
        states { nodes { id name type position } }
      }
    }`,
    { teamId: resolvedTeamId }
  );
  return data.team.states.nodes
    .sort((a, b) => a.position - b.position)
    .map((s) => `${s.name}  [${s.type}]  (${s.id})`)
    .join("\n");
}

async function createIssue({ title, teamId, description, priority, status }) {
  const resolvedTeamId = teamId || DEFAULT_TEAM_ID;
  if (!resolvedTeamId) {
    throw new Error("teamId is required. Pass a team key (e.g., 'CRAB') or set LINEAR_TEAM_ID environment variable.");
  }
  const teamIdUuid = await resolveTeamId(resolvedTeamId);
  const data = await gql(
    `mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { id identifier url title } }
    }`,
    { input: { title, teamId: teamIdUuid, description, priority, stateId: status } }
  );
  const issue = data.issueCreate.issue;
  return `Created issue ${issue.identifier}: ${issue.title}\nURL: ${issue.url}`;
}

async function updateIssue({ id, title, description, priority, status }) {
  const uuid = await resolveIssueId(id);
  const input = {};
  if (title !== undefined) input.title = title;
  if (description !== undefined) input.description = description;
  if (priority !== undefined) input.priority = priority;
  if (status !== undefined) input.stateId = status;

  const data = await gql(
    `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success issue { id identifier url title } }
    }`,
    { id: uuid, input }
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
  teamId = await resolveTeamId(teamId);
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
        `  URL: ${i.url}` +
        (i.description ? `\n\n${i.description}` : "")
    )
    .join("\n\n---\n\n");
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
  const uuid = await resolveIssueId(issueId);
  const data = await gql(
    `mutation AddComment($input: CommentCreateInput!) {
      commentCreate(input: $input) { success comment { id url } }
    }`,
    {
      input: {
        issueId: uuid,
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
    name: "linear_get_issue",
    description:
      "Retrieves a single Linear issue by ID or identifier (e.g. 'CRB-10'). Returns full details: description, comments, labels, assignee, status, priority, estimates, dates.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Issue ID (UUID) or identifier (e.g. 'CRB-10')" },
      },
      required: ["id"],
    },
  },
  {
    name: "linear_get_issue_comments",
    description: "Retrieves all comments for a Linear issue by ID or identifier.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Issue ID (UUID) or identifier (e.g. 'CRB-10')" },
        limit: { type: "number", description: "Max comments to return (default: 50)" },
      },
      required: ["id"],
    },
  },
  {
    name: "linear_list_teams",
    description: "Lists all Linear teams with their key, name, and UUID.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "linear_list_states",
    description: "Lists workflow states for a team (useful for finding state IDs when creating/updating issues).",
    inputSchema: {
      type: "object",
      properties: {
        teamId: { type: "string", description: "Team ID or key (e.g., 'CRAB'). Optional if LINEAR_TEAM_ID is set." },
      },
    },
  },
  {
    name: "linear_create_issue",
    description:
      "Creates a new Linear issue. Returns the created issue's identifier and URL.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Issue title" },
        teamId: { 
          type: "string", 
          description: "Team ID or key (e.g., 'CRAB', 'ENG'). Optional if LINEAR_TEAM_ID env var is set." 
        },
        description: { type: "string", description: "Issue description (markdown supported)" },
        priority: { type: "number", description: "Priority: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low" },
        status: { type: "string", description: "State ID to set initial status (optional)" },
      },
      required: ["title"],
    },
  },
  {
    name: "linear_update_issue",
    description:
      "Updates an existing Linear issue. Accepts issue UUID or human identifier (e.g. 'CRB-10').",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Issue UUID or identifier (e.g. 'CRB-10')" },
        title: { type: "string", description: "New title" },
        description: { type: "string", description: "New description (markdown supported)" },
        priority: { type: "number", description: "New priority: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low" },
        status: { type: "string", description: "New state ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "linear_search_issues",
    description:
      "Searches Linear issues by text query and/or filters. Returns matching issues with ID, status, priority, assignee, team, and URL.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search in title/description" },
        teamId: { type: "string", description: "Filter by team ID or key (e.g., 'CRAB')" },
        status: { type: "string", description: "Filter by status name (e.g., 'In Progress', 'Todo')" },
        assigneeId: { type: "string", description: "Filter by assignee user ID" },
        labels: { type: "array", items: { type: "string" }, description: "Filter by label names" },
        priority: { type: "number", description: "Filter by priority: 1=Urgent, 2=High, 3=Medium, 4=Low" },
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
    description: "Adds a markdown comment to a Linear issue. Accepts issue UUID or identifier (e.g. 'CRB-10').",
    inputSchema: {
      type: "object",
      properties: {
        issueId: { type: "string", description: "Issue UUID or identifier (e.g. 'CRB-10')" },
        body: { type: "string", description: "Comment text (markdown)" },
        createAsUser: { type: "string", description: "Custom username for comment" },
        displayIconUrl: { type: "string", description: "Avatar URL for comment" },
      },
      required: ["issueId", "body"],
    },
  },
];

const TOOL_HANDLERS = {
  linear_get_issue: getIssue,
  linear_get_issue_comments: getIssueComments,
  linear_list_teams: listTeams,
  linear_list_states: listStates,
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
        try {
          const text = await handler(args ?? {});
          respond(id, { content: [{ type: "text", text }] });
        } catch (err) {
          const hint = err.message.includes("team") 
            ? " Hint: Use a team key like 'CRAB' or set LINEAR_TEAM_ID env var."
            : "";
          error(id, -32000, `${err.message}${hint}`);
        }
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
