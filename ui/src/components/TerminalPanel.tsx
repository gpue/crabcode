import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { interruptTerminalCommand, runTerminalCommand } from "../lib/api";
import type { TerminalResult } from "../lib/types";
import { Icon } from "./Icon";

interface TerminalPanelProps {
  open: boolean;
  onClose: () => void;
}

export function TerminalPanel({ open, onClose }: TerminalPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(420);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const commandRef = useRef("");
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(-1);
  const runningRef = useRef(false);
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);

  function prompt() {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.write("\r\n\x1b[35mnova-opencode\x1b[0m:\x1b[36m/workspace\x1b[0m$ ");
    commandRef.current = "";
    historyIndexRef.current = historyRef.current.length;
  }

  function rewriteInput(nextValue: string) {
    const terminal = terminalRef.current;
    if (!terminal) return;
    for (let i = 0; i < commandRef.current.length; i += 1) {
      terminal.write("\b \b");
    }
    commandRef.current = nextValue;
    if (nextValue) {
      terminal.write(nextValue);
    }
  }

  function historyMove(direction: -1 | 1) {
    if (runningRef.current) return;
    const history = historyRef.current;
    if (!history.length) return;
    const nextIndex = Math.max(0, Math.min(history.length, historyIndexRef.current + direction));
    historyIndexRef.current = nextIndex;
    const nextCommand = nextIndex >= history.length ? "" : history[nextIndex];
    rewriteInput(nextCommand);
  }

  function writeResult(result: TerminalResult) {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    const exitCode = typeof result.exitCode === "number" ? result.exitCode : -1;
    const hasOutput = stdout.length > 0 || stderr.length > 0;
    if (stdout) {
      terminal.write(stdout);
      if (!stdout.endsWith("\n")) terminal.write("\r\n");
    }
    if (stderr) {
      terminal.write(`\x1b[31m${stderr}\x1b[0m`);
      if (!stderr.endsWith("\n")) terminal.write("\r\n");
    }
    if (!hasOutput) {
      terminal.writeln("\x1b[90m(no output)\x1b[0m");
    }
    terminal.writeln(`\x1b[90mexit ${exitCode}\x1b[0m`);
    prompt();
  }

  useEffect(() => {
    if (!hostRef.current || terminalRef.current) return;
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      theme: {
        background: "#0b1020",
        foreground: "#e2e8f0",
        cursor: "#5eead4",
        selectionBackground: "rgba(142,86,252,0.24)",
      },
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 13,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(hostRef.current);
    fitAddon.fit();
    terminal.writeln("Nova OpenCode terminal ready.");
    prompt();

    terminal.onData(async (data) => {
      if (!open) return;
      if (runningRef.current) return;
      if (data === "\r") {
        const command = commandRef.current.trim();
        runningRef.current = true;
        terminal.write("\r\n");
        if (!command) {
          runningRef.current = false;
          prompt();
          return;
        }
        historyRef.current.push(command);
        historyIndexRef.current = historyRef.current.length;
        try {
          const result = await runTerminalCommand(command);
          writeResult(result);
          setError(null);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Terminal command failed";
          setError(message);
          terminal.writeln(`\x1b[31m${message}\x1b[0m`);
          prompt();
        } finally {
          runningRef.current = false;
        }
        return;
      }
      if (data === "\u0003") {
        if (runningRef.current) {
          terminal.write("^C\r\n");
          try {
            const interrupt = await interruptTerminalCommand();
            if (interrupt.signaled) {
              terminal.writeln("\x1b[90minterrupt signal sent\x1b[0m");
            } else {
              terminal.writeln("\x1b[90mno running command\x1b[0m");
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to interrupt command";
            terminal.writeln(`\x1b[31m${message}\x1b[0m`);
          }
          return;
        }
        terminal.write("^C");
        prompt();
        return;
      }
      if (data === "\u001b[A") {
        historyMove(-1);
        return;
      }
      if (data === "\u001b[B") {
        historyMove(1);
        return;
      }
      if (data === "\u007f") {
        if (commandRef.current.length > 0) {
          commandRef.current = commandRef.current.slice(0, -1);
          terminal.write("\b \b");
        }
        return;
      }
      if (data >= " ") {
        commandRef.current += data;
        terminal.write(data);
      }
    });

    terminalRef.current = terminal;
    fitRef.current = fitAddon;
    const onResize = () => fitAddon.fit();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
      window.setTimeout(() => fitRef.current?.fit(), 50);
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    window.requestAnimationFrame(() => fitRef.current?.fit());
  }, [height, open]);

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      if (!resizeRef.current) return;
      const next = resizeRef.current.startHeight + (resizeRef.current.startY - event.clientY);
      setHeight(Math.max(260, Math.min(window.innerHeight - 120, next)));
    };
    const handleUp = () => {
      resizeRef.current = null;
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

  function startResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    resizeRef.current = { startY: event.clientY, startHeight: height };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }

  return (
    <section className={`terminal-overlay${open ? " open" : ""}`}>
      <div className="terminal-overlay-backdrop" onClick={onClose} />
      <div className="terminal-panel terminal-panel-sheet" style={{ height }}>
        <button className="terminal-resize-handle" type="button" aria-label="Resize terminal" onPointerDown={startResize} />
        <div className="terminal-head">
          <div>
            <h2>Workspace terminal</h2>
            <p>Execute bash commands in /workspace.</p>
          </div>
          <button className="panel-close-button" type="button" onClick={onClose} title="Close terminal">
            <Icon name="close" width="14" height="14" />
            <span>Close</span>
          </button>
        </div>
        <div className="terminal-screen" ref={hostRef} />
        {error ? <div className="page-state error terminal-error">{error}</div> : null}
      </div>
    </section>
  );
}
