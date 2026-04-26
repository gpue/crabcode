export type Lane = "later" | "next" | "now";
export type AgentMode = "build" | "plan";

export interface SessionSummary {
  id: string;
  title: string;
  preview: string;
  updatedAt: string | null;
  lane: Lane;
  archived: boolean;
  running: boolean;
  messageCount: number;
}

export interface BoardData {
  lanes: Record<Lane, SessionSummary[]>;
  archiveCount: number;
}

export interface SessionMessagePart {
  id?: string;
  type?: string;
  text?: string;
  [key: string]: unknown;
}

export interface SessionMessage {
  id: string;
  info?: {
    role?: string;
    [key: string]: unknown;
  };
  role?: string;
  createdAt?: string;
  parts?: SessionMessagePart[];
  [key: string]: unknown;
}

export interface SessionDetail {
  id: string;
  title: string;
  updatedAt: string | null;
  running: boolean;
  messages: SessionMessage[];
}

export interface WorkspaceNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: WorkspaceNode[];
}

export interface WorkspaceFile {
  path: string;
  content: string;
}

export interface TerminalResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProviderModelOption {
  providerID: string;
  modelID: string;
  name: string;
  variants: string[];
}

export interface ComposerOptions {
  models: ProviderModelOption[];
  defaultModel: { providerID: string; modelID: string } | null;
}

export interface ProviderAuthMethod {
  type: "oauth" | "api";
  label: string;
}

export interface ProviderConnectionSummary {
  connected: string[];
}

export interface ProviderOAuthAuthorization {
  url: string;
  method: string;
  instructions: string;
}

export interface PromptOptions {
  providerID: string;
  modelID: string;
  variant: string;
  mode: AgentMode;
}

export interface SessionProgressEvent {
  type: string;
  sessionID?: string;
  messageID?: string;
}

export interface StreamEnvelope<T = unknown> {
  event?: string;
  data?: T;
}
