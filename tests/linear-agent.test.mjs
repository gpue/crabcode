/**
 * Tests for the linear-agent workflow logic.
 *
 * Uses Node.js built-in test runner and a mock HTTP server to simulate
 * Linear GraphQL API and OpenCode MCP bridge responses.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Mock servers ────────────────────────────────────────────────

let linearServer;
let opencodeServer;
let linearPort;
let opencodePort;

// Captured requests for assertions
let linearRequests = [];
let opencodeRequests = [];

// Configurable mock responses
let linearResponses = {};
let opencodeResponses = {};

function createLinearServer() {
  return new Promise((resolve) => {
    linearServer = http.createServer(async (req, res) => {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      linearRequests.push(parsed);

      const queryKey = detectQueryType(parsed.query);
      const response = linearResponses[queryKey] || { data: {} };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    });
    linearServer.listen(0, "127.0.0.1", () => {
      linearPort = linearServer.address().port;
      resolve();
    });
  });
}

function createOpencodeServer() {
  return new Promise((resolve) => {
    opencodeServer = http.createServer(async (req, res) => {
      const body = await readBody(req);
      opencodeRequests.push({ method: req.method, url: req.url, body });

      if (req.url === "/session" && req.method === "POST") {
        const resp = opencodeResponses.createSession || { id: "test-session-001" };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(resp));
      } else if (req.url?.includes("/prompt") && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else if (req.url?.includes("/session/") && req.method === "GET") {
        const resp = opencodeResponses.getSession || { status: "idle" };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(resp));
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
    opencodeServer.listen(0, "127.0.0.1", () => {
      opencodePort = opencodeServer.address().port;
      resolve();
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

function detectQueryType(query) {
  if (query.includes("users")) return "users";
  if (query.includes("issues") && query.includes("filter")) return "issues";
  if (query.includes("issueUpdate")) return "issueUpdate";
  if (query.includes("commentCreate")) return "commentCreate";
  if (query.includes("states")) return "states";
  return "unknown";
}

// ── Test fixtures ───────────────────────────────────────────────

const CRAB_USER = {
  id: "crab-user-id-123",
  name: "crab",
  displayName: "crab",
  active: true,
};

const SAMPLE_TICKET = {
  id: "ticket-001",
  identifier: "PROJ-42",
  title: "Fix login page CSS",
  description: "The login button is misaligned on mobile viewports.",
  state: { name: "Todo", type: "unstarted" },
  labels: { nodes: [] },
  priority: 2,
  url: "https://linear.app/team/PROJ-42",
  assignee: { id: "crab-user-id-123", name: "crab" },
  comments: { nodes: [] },
};

const WORKFLOW_STATES = [
  { id: "state-backlog", name: "Backlog", type: "backlog" },
  { id: "state-todo", name: "Todo", type: "unstarted" },
  { id: "state-progress", name: "In Progress", type: "started" },
  { id: "state-done", name: "Done", type: "completed" },
  { id: "state-cancelled", name: "Cancelled", type: "cancelled" },
];

// ── Tests ───────────────────────────────────────────────────────

describe("Linear Agent", () => {
  before(async () => {
    await createLinearServer();
    await createOpencodeServer();
  });

  after(() => {
    linearServer?.close();
    opencodeServer?.close();
  });

  beforeEach(() => {
    linearRequests = [];
    opencodeRequests = [];
    linearResponses = {};
    opencodeResponses = {};
  });

  describe("User resolution", () => {
    it("should resolve crab user by name from Linear API", async () => {
      linearResponses.users = {
        data: { users: { nodes: [CRAB_USER, { id: "other", name: "Georg", displayName: "georg", active: true }] } },
      };

      const res = await fetch(`http://127.0.0.1:${linearPort}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ users { nodes { id name displayName active } } }" }),
      });
      const data = await res.json();
      const crab = data.data.users.nodes.find(
        (u) => u.active && u.name.toLowerCase().includes("crab")
      );
      assert.ok(crab, "Should find crab user");
      assert.equal(crab.id, "crab-user-id-123");
    });

    it("should return null if no crab user exists", async () => {
      linearResponses.users = {
        data: { users: { nodes: [{ id: "other", name: "Georg", displayName: "georg", active: true }] } },
      };

      const res = await fetch(`http://127.0.0.1:${linearPort}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ users { nodes { id name displayName active } } }" }),
      });
      const data = await res.json();
      const crab = data.data.users.nodes.find(
        (u) => u.active && u.name.toLowerCase().includes("crab")
      );
      assert.equal(crab, undefined, "Should not find crab user");
    });
  });

  describe("Ticket fetching", () => {
    it("should fetch tickets assigned to crab with correct filter", async () => {
      linearResponses.issues = {
        data: { issues: { nodes: [SAMPLE_TICKET] } },
      };

      const filter = {
        assignee: { id: { eq: CRAB_USER.id } },
        state: { type: { in: ["started", "unstarted"] } },
      };

      const res = await fetch(`http://127.0.0.1:${linearPort}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `query($filter: IssueFilter) { issues(filter: $filter, first: 20) { nodes { id identifier title } } }`,
          variables: { filter },
        }),
      });
      const data = await res.json();
      assert.equal(data.data.issues.nodes.length, 1);
      assert.equal(data.data.issues.nodes[0].identifier, "PROJ-42");
    });
  });

  describe("Ticket workflow", () => {
    it("should create an OpenCode session when starting a ticket", async () => {
      opencodeResponses.createSession = { id: "session-abc" };

      const res = await fetch(`http://127.0.0.1:${opencodePort}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lane: "now" }),
      });
      const data = await res.json();
      assert.equal(data.id, "session-abc");
      assert.equal(opencodeRequests.length, 1);
      assert.equal(opencodeRequests[0].method, "POST");
    });

    it("should send prompt with ticket details to OpenCode session", async () => {
      const prompt = [
        `## Linear Ticket: ${SAMPLE_TICKET.identifier} — ${SAMPLE_TICKET.title}`,
        "",
        SAMPLE_TICKET.description,
        "",
        `Ticket URL: ${SAMPLE_TICKET.url}`,
      ].join("\n");

      const res = await fetch(
        `http://127.0.0.1:${opencodePort}/session/session-abc/prompt`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            providerID: "copilot",
            modelID: "claude-sonnet-4",
            variant: "medium",
            mode: "code",
          }),
        }
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(opencodeRequests[0].body);
      assert.ok(body.prompt.includes("PROJ-42"));
      assert.equal(body.providerID, "copilot");
    });

    it("should move ticket to In Progress via issueUpdate mutation", async () => {
      linearResponses.states = {
        data: {
          issue: { team: { states: { nodes: WORKFLOW_STATES } } },
        },
      };
      linearResponses.issueUpdate = {
        data: { issueUpdate: { issue: { id: "ticket-001", state: { name: "In Progress" } } } },
      };

      // Simulate getting states
      const statesRes = await fetch(`http://127.0.0.1:${linearPort}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `query($issueId: String!) { issue(id: $issueId) { team { states { nodes { id name type } } } } }`,
          variables: { issueId: "ticket-001" },
        }),
      });
      const statesData = await statesRes.json();
      const startedState = statesData.data.issue.team.states.nodes.find(
        (s) => s.type === "started"
      );
      assert.ok(startedState);
      assert.equal(startedState.name, "In Progress");

      // Simulate update
      const updateRes = await fetch(`http://127.0.0.1:${linearPort}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation($issueId: String!, $stateId: String!) { issueUpdate(id: $issueId, input: { stateId: $stateId }) { issue { id state { name } } } }`,
          variables: { issueId: "ticket-001", stateId: startedState.id },
        }),
      });
      assert.equal(updateRes.status, 200);
    });

    it("should add a comment when starting work", async () => {
      linearResponses.commentCreate = {
        data: { commentCreate: { comment: { id: "comment-001" } } },
      };

      const res = await fetch(`http://127.0.0.1:${linearPort}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { comment { id } } }`,
          variables: {
            issueId: "ticket-001",
            body: "🦀 **crab** is picking up this ticket.",
          },
        }),
      });
      assert.equal(res.status, 200);
      assert.ok(linearRequests[0].variables.body.includes("crab"));
    });
  });

  describe("Prompt building", () => {
    it("should include ticket identifier, title, and description", () => {
      // Inline version of buildPrompt for testing
      const ticket = SAMPLE_TICKET;
      const parts = [
        `## Linear Ticket: ${ticket.identifier} — ${ticket.title}`,
        "",
        ticket.description || "No description provided.",
        "",
        `Ticket URL: ${ticket.url}`,
      ];
      const prompt = parts.join("\n");

      assert.ok(prompt.includes("PROJ-42"));
      assert.ok(prompt.includes("Fix login page CSS"));
      assert.ok(prompt.includes("misaligned on mobile"));
      assert.ok(prompt.includes("https://linear.app/team/PROJ-42"));
    });

    it("should handle tickets without description", () => {
      const ticket = { ...SAMPLE_TICKET, description: null };
      const desc = ticket.description || "No description provided.";
      assert.equal(desc, "No description provided.");
    });

    it("should include recent comments excluding crab's own", () => {
      const comments = [
        { body: "Please also fix the header", user: { name: "Georg" } },
        { body: "Starting work...", user: { name: "crab" } },
      ];
      const filtered = comments.filter((c) => c.user?.name !== "crab");
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0].user.name, "Georg");
    });
  });
});

// ── E2E: session creation and prompt delivery ────────────────────

describe("E2E: linear-agent session creation and prompt delivery", () => {
  let e2eServer;
  let e2ePort;
  let e2eRequests = [];
  let e2eResponses = {};

  // Lazily imported real functions (requires OPENCODE_MCP_URL env to be set first)
  let createOpenCodeSession;
  let sendPromptToSession;
  let buildPrompt;

  before(async () => {
    // Start a mock OpenCode server
    await new Promise((resolve) => {
      e2eServer = http.createServer(async (req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        await new Promise((r) => req.on("end", r));
        const body = Buffer.concat(chunks).toString();
        e2eRequests.push({ method: req.method, url: req.url, body });

        if (req.url === "/session" && req.method === "POST") {
          const resp = e2eResponses.createSession ?? { id: "e2e-session-001" };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(resp));
        } else if (req.url?.includes("/prompt") && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else if (req.url?.includes("/session/") && req.method === "GET") {
          const resp = e2eResponses.getSession ?? { status: "idle" };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(resp));
        } else {
          res.writeHead(404);
          res.end("not found");
        }
      });
      e2eServer.listen(0, "127.0.0.1", () => {
        e2ePort = e2eServer.address().port;
        resolve();
      });
    });

    // Set env vars before importing so the module picks up the right base URL
    process.env.OPENCODE_MCP_URL = `http://127.0.0.1:${e2ePort}`;
    process.env.LINEAR_API_KEY = "test-key";

    const agentPath = path.resolve(
      fileURLToPath(import.meta.url),
      "../../scripts/linear-agent.mjs"
    );
    const mod = await import(agentPath);
    createOpenCodeSession = mod.createOpenCodeSession;
    sendPromptToSession = mod.sendPromptToSession;
    buildPrompt = mod.buildPrompt;
  });

  after(() => {
    e2eServer?.close();
  });

  beforeEach(() => {
    e2eRequests = [];
    e2eResponses = {};
  });

  it("createOpenCodeSession sends POST /session and returns session id", async () => {
    e2eResponses.createSession = { id: "e2e-session-xyz" };

    const id = await createOpenCodeSession("PROJ-42: Fix login page", "/workspace/proj");

    assert.equal(id, "e2e-session-xyz");
    assert.equal(e2eRequests.length, 1);
    assert.equal(e2eRequests[0].method, "POST");
    assert.equal(e2eRequests[0].url, "/session");

    const body = JSON.parse(e2eRequests[0].body);
    assert.equal(body.lane, "now");
    assert.equal(body.title, "PROJ-42: Fix login page");
    assert.equal(body.directory, "/workspace/proj");
  });

  it("createOpenCodeSession omits directory when not provided", async () => {
    e2eResponses.createSession = { id: "e2e-session-no-dir" };

    const id = await createOpenCodeSession("PROJ-1: Task");

    assert.equal(id, "e2e-session-no-dir");
    const body = JSON.parse(e2eRequests[0].body);
    assert.equal(body.directory, undefined);
  });

  it("sendPromptToSession sends POST /session/:id/prompt with correct payload", async () => {
    const ticket = {
      id: "ticket-001",
      identifier: "PROJ-42",
      title: "Fix login page CSS",
      description: "The login button is misaligned on mobile viewports.",
      url: "https://linear.app/team/PROJ-42",
      state: { name: "Todo", type: "unstarted" },
      labels: { nodes: [] },
      comments: { nodes: [] },
    };

    const prompt = buildPrompt(ticket, "/workspace/proj");
    await sendPromptToSession("e2e-session-abc", prompt);

    assert.equal(e2eRequests.length, 1);
    assert.equal(e2eRequests[0].method, "POST");
    assert.ok(e2eRequests[0].url.includes("/session/e2e-session-abc/prompt"));

    const body = JSON.parse(e2eRequests[0].body);
    assert.ok(body.prompt.includes("PROJ-42"), "prompt includes ticket identifier");
    assert.ok(body.prompt.includes("Fix login page CSS"), "prompt includes ticket title");
    assert.equal(body.providerID, "github-copilot");
    assert.equal(body.modelID, "claude-sonnet-4");
    assert.equal(body.mode, "code");
  });

  it("full flow: create session then deliver prompt", async () => {
    e2eResponses.createSession = { id: "e2e-flow-session" };

    const ticket = {
      id: "ticket-002",
      identifier: "CRB-32",
      title: "E2E test: session and prompt",
      description: "Verify that the agent creates a session and delivers the prompt.",
      url: "https://linear.app/team/CRB-32",
      state: { name: "Todo", type: "unstarted" },
      labels: { nodes: [] },
      comments: { nodes: [] },
    };

    // Step 1: create session
    const sessionId = await createOpenCodeSession(
      `${ticket.identifier}: ${ticket.title}`,
      "/workspace/crabcode"
    );
    assert.equal(sessionId, "e2e-flow-session");

    // Step 2: build and deliver prompt
    const prompt = buildPrompt(ticket, "/workspace/crabcode");
    await sendPromptToSession(sessionId, prompt);

    assert.equal(e2eRequests.length, 2);

    // Verify session creation request
    assert.equal(e2eRequests[0].url, "/session");
    const sessionBody = JSON.parse(e2eRequests[0].body);
    assert.equal(sessionBody.title, "CRB-32: E2E test: session and prompt");

    // Verify prompt delivery request
    assert.ok(e2eRequests[1].url.includes("/session/e2e-flow-session/prompt"));
    const promptBody = JSON.parse(e2eRequests[1].body);
    assert.ok(promptBody.prompt.includes("CRB-32"));
    assert.ok(promptBody.prompt.includes("/workspace/crabcode"));
    assert.equal(promptBody.providerID, "github-copilot");
  });
});
