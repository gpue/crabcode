import Editor from "@monaco-editor/react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getWorkspaceFile, getWorkspaceTree, saveWorkspaceFile } from "../lib/api";
import type { WorkspaceNode } from "../lib/types";
import { Icon } from "./Icon";

interface WorkspacePanelProps {
  open: boolean;
  onClose: () => void;
  mode?: "inline" | "overlay";
}

function TreeNode({
  node,
  selectedPath,
  onSelect,
  depth = 0,
}: {
  node: WorkspaceNode;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(node.type === "directory" && depth === 0);

  if (node.type === "file") {
    return (
      <button className={`workspace-node workspace-file${selectedPath === node.path ? " selected" : ""}`} type="button" onClick={() => onSelect(node.path)}>
        <Icon name="open" className="workspace-node-icon" width="14" height="14" />
        <span className="workspace-node-label">{node.name}</span>
      </button>
    );
  }

  return (
    <div className="workspace-branch">
      <button className="workspace-node workspace-folder" type="button" onClick={() => setExpanded((current) => !current)}>
        <span>{expanded ? "▾" : "▸"}</span>
        <Icon name="folder" className="workspace-node-icon" width="14" height="14" />
        <span className="workspace-node-label">{node.name}</span>
      </button>
      {expanded ? (
        <div className="workspace-children">
          {(node.children || []).map((child) => (
            <TreeNode key={child.path} node={child} selectedPath={selectedPath} onSelect={onSelect} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const languageOptions = [
  { value: "auto", label: "Auto" },
  { value: "plaintext", label: "Plain text" },
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "json", label: "JSON" },
  { value: "python", label: "Python" },
  { value: "bash", label: "Shell" },
  { value: "yaml", label: "YAML" },
  { value: "markdown", label: "Markdown" },
  { value: "html", label: "HTML" },
  { value: "css", label: "CSS" },
  { value: "sql", label: "SQL" },
];

function detectLanguage(path: string | null): string {
  if (!path) return "plaintext";
  const lower = path.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return "bash";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".html")) return "html";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".sql")) return "sql";
  return "plaintext";
}

export function WorkspacePanel({ open, onClose, mode = "inline" }: WorkspacePanelProps) {
  const [tree, setTree] = useState<WorkspaceNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [language, setLanguage] = useState("auto");
  const [panelWidth, setPanelWidth] = useState(820);
  const [treeWidth, setTreeWidth] = useState(250);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const panelResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const treeResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      if (panelResizeRef.current) {
        const next = panelResizeRef.current.startWidth + (panelResizeRef.current.startX - event.clientX);
        setPanelWidth(Math.max(620, Math.min(window.innerWidth - 32, next)));
      }
      if (treeResizeRef.current) {
        const next = treeResizeRef.current.startWidth + (event.clientX - treeResizeRef.current.startX);
        setTreeWidth(Math.max(180, Math.min(420, next)));
      }
    };

    const handleUp = () => {
      panelResizeRef.current = null;
      treeResizeRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    getWorkspaceTree()
      .then((data) => setTree(data.tree))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load workspace"));
  }, [open]);

  useEffect(() => {
    if (!selectedPath) return;
    setLoading(true);
    getWorkspaceFile(selectedPath)
      .then((file) => {
        setContent(file.content);
        setLanguage("auto");
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load file"))
      .finally(() => setLoading(false));
  }, [selectedPath]);

  const flatFiles = useMemo(() => {
    const files: WorkspaceNode[] = [];
    const walk = (nodes: WorkspaceNode[]) => {
      for (const node of nodes) {
        if (node.type === "file") files.push(node);
        if (node.children) walk(node.children);
      }
    };
    walk(tree);
    return files;
  }, [tree]);

  useEffect(() => {
    if (!selectedPath && flatFiles.length > 0) {
      setSelectedPath(flatFiles[0].path);
    }
  }, [flatFiles, selectedPath]);

  async function handleSave() {
    if (!selectedPath) return;
    setSaving(true);
    try {
      await saveWorkspaceFile(selectedPath, content);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save file");
    } finally {
      setSaving(false);
    }
  }

  function getUploadTargetDir(): string {
    if (!selectedPath) return "";
    const lastSlash = selectedPath.lastIndexOf("/");
    return lastSlash >= 0 ? selectedPath.slice(0, lastSlash + 1) : "";
  }

  async function handleUpload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    const targetDir = getUploadTargetDir();
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const content = await file.text();
        const path = targetDir ? `${targetDir}${file.name}` : file.name;
        await saveWorkspaceFile(path, content);
      }
      const { tree: newTree } = await getWorkspaceTree();
      setTree(newTree);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upload file(s)");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const resolvedLanguage = language === "auto" ? detectLanguage(selectedPath) : language;

  function startPanelResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    panelResizeRef.current = { startX: event.clientX, startWidth: panelWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function startTreeResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    treeResizeRef.current = { startX: event.clientX, startWidth: treeWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  const panel = (
    <aside className={`workspace-panel ${mode}${open ? " open" : ""}`} style={mode === "overlay" ? { width: panelWidth } : undefined}>
      {mode === "overlay" ? <button className="workspace-resize-handle workspace-panel-resize" type="button" aria-label="Resize workspace panel" onPointerDown={startPanelResize} /> : null}
      {mode === "overlay" ? (
        <button className="workspace-overlay-close" type="button" onClick={onClose} aria-label="Close workspace" title="Close workspace">
          <Icon name="close" width="14" height="14" />
          <span>Close</span>
        </button>
      ) : null}
      <div className="workspace-panel-head">
        <div>
          <h2>Workspace</h2>
          <p>Browse and edit files on the PVC.</p>
        </div>
        {mode === "inline" ? (
          <button className="panel-close-button" type="button" onClick={onClose} title="Close workspace">
            <Icon name="close" width="14" height="14" />
            <span>Close</span>
          </button>
        ) : null}
      </div>
      {error ? <div className="page-state error">{error}</div> : null}
      <div className="workspace-panel-body" style={{ gridTemplateColumns: `${treeWidth}px 10px minmax(0, 1fr)` }}>
        <div className="workspace-tree-wrap">
          <div className="workspace-tree-toolbar">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="workspace-upload-input"
              onChange={(e) => handleUpload(e.target.files)}
              aria-label="Upload files"
            />
            <button
              className="archive-pill"
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              title="Upload files to workspace"
            >
              <Icon name="upload" width="14" height="14" />
              <span>{uploading ? "Uploading..." : "Upload"}</span>
            </button>
          </div>
          <div className="workspace-tree">
            {tree.map((node) => (
            <TreeNode key={node.path} node={node} selectedPath={selectedPath} onSelect={setSelectedPath} />
          ))}
          </div>
        </div>
        <button className="workspace-resize-handle workspace-splitter" type="button" aria-label="Resize explorer" onPointerDown={startTreeResize} />
        <div className="workspace-editor-wrap">
          <div className="workspace-editor-head">
            <span className="workspace-file-path">{selectedPath || "No file selected"}</span>
            <div className="workspace-editor-actions">
              <label className="workspace-language-select">
                <span>Language</span>
                <select value={language} onChange={(event) => setLanguage(event.target.value)} disabled={!selectedPath}>
                  {languageOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <button className="lane-new-button" type="button" onClick={handleSave} disabled={!selectedPath || saving} title="Save current file">
                <Icon name="save" width="14" height="14" />
                <span>{saving ? "Saving..." : "Save"}</span>
              </button>
            </div>
          </div>
          <div className="workspace-editor-shell">
            <Editor
              className="workspace-monaco"
              height="100%"
              language={resolvedLanguage}
              loading={loading ? "Loading file..." : "Preparing editor..."}
              options={{
                automaticLayout: true,
                fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                fontSize: 13,
                lineHeight: 22,
                minimap: { enabled: false },
                padding: { top: 16, bottom: 16 },
                readOnly: !selectedPath || loading,
                roundedSelection: true,
                scrollBeyondLastLine: false,
                wordWrap: "on",
              }}
              theme="vs-dark"
              value={content}
              onChange={(value) => setContent(value ?? "")}
            />
            {!selectedPath && !loading ? <div className="workspace-empty-state">Select a file to edit.</div> : null}
          </div>
        </div>
      </div>
    </aside>
  );

  if (mode === "overlay") {
    return (
      <div className={`workspace-overlay${open ? " open" : ""}`}>
        <div className="workspace-overlay-backdrop" onClick={onClose} />
        {panel}
      </div>
    );
  }

  return panel;
}
