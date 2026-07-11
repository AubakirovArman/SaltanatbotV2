import { BookOpen, Bookmark, Pencil, Plus, Save, Send, Terminal, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { COMMAND_REFERENCE } from "../commandReference";
import { loadSavedCommands, newCommandId, persistSavedCommands, type SavedCommand } from "../savedCommands";
import type { TradingBot } from "../tradeClient";

interface BotCommandConsoleProps {
  bot: Pick<TradingBot, "symbol" | "status">;
  output?: string;
  onRun: (command: string, dryRun?: boolean) => Promise<void>;
}

export function BotCommandConsole({ bot, output, onRun }: BotCommandConsoleProps) {
  const [command, setCommand] = useState("");
  const [showReference, setShowReference] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [saved, setSaved] = useState<SavedCommand[]>([]);
  const [editor, setEditor] = useState<{ id?: string; name: string; command: string } | null>(null);

  useEffect(() => setSaved(loadSavedCommands()), []);

  const run = async (input: string, dryRun = false) => {
    if (!input.trim()) return;
    await onRun(input, dryRun);
    if (!dryRun && input === command) setCommand("");
  };
  const openEditor = (id: string | undefined, value: string, name = "") => {
    setShowSaved(true);
    setEditor({ id, name, command: value });
  };
  const saveEditor = () => {
    if (!editor) return;
    const next = editor.id
      ? saved.map((item) => item.id === editor.id ? { ...item, name: editor.name.trim(), command: editor.command.trim() } : item)
      : [{ id: newCommandId(), name: editor.name.trim(), command: editor.command.trim() }, ...saved];
    setSaved(next);
    persistSavedCommands(next);
    setEditor(null);
  };
  const removeSaved = (id: string) => {
    const next = saved.filter((item) => item.id !== id);
    setSaved(next);
    persistSavedCommands(next);
  };

  return (
    <section className="trade-console" aria-label="Command console">
      <div className="panel-header small">
        <strong><Terminal size={13} aria-hidden="true" /> Command console</strong>
        <span className="console-toggles">
          <button type="button" className={`link-button ${showSaved ? "on" : ""}`} aria-expanded={showSaved} onClick={() => { setShowSaved((value) => !value); setShowReference(false); }}>
            <Bookmark size={13} aria-hidden="true" /> Saved
          </button>
          <button type="button" className={`link-button ${showReference ? "on" : ""}`} aria-expanded={showReference} onClick={() => { setShowReference((value) => !value); setShowSaved(false); }}>
            <BookOpen size={13} aria-hidden="true" /> Reference
          </button>
        </span>
      </div>

      <form className="trade-console-input" onSubmit={(event) => { event.preventDefault(); void run(command); }}>
        <input name="bot-command" aria-label="Bot command" value={command} placeholder="action=openposition;side=buy;openpro=25;lev=5" onChange={(event) => setCommand(event.target.value)} disabled={bot.status !== "running"} />
        <button type="button" title="Save command" className="console-save" onClick={() => command.trim() && openEditor(undefined, command)} disabled={!command.trim()}><Save size={14} aria-hidden="true" /></button>
        <button type="button" className="console-dry" title="Dry run (preview without executing)" onClick={() => void run(command, true)} disabled={bot.status !== "running" || !command.trim()}>Dry</button>
        <button type="submit" aria-label="Run command" disabled={bot.status !== "running"}><Send size={14} aria-hidden="true" /></button>
      </form>
      {output && <div className="trade-console-out num" role="status">{output}</div>}

      {editor && (
        <form className="cmd-editor" onSubmit={(event) => { event.preventDefault(); saveEditor(); }}>
          <label>Command name<input name="command-name" className="cmd-editor-name" value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></label>
          <label>Antares command<textarea name="command-body" className="cmd-editor-body" rows={3} value={editor.command} onChange={(event) => setEditor({ ...editor, command: event.target.value })} /></label>
          <div className="cmd-editor-actions">
            <button type="submit" className="run-button" disabled={!editor.name.trim() || !editor.command.trim()}>Save</button>
            <button type="button" onClick={() => setEditor(null)}>Cancel</button>
          </div>
        </form>
      )}

      {showSaved && (
        <div className="cmd-reference">
          <div className="cmd-saved-head"><span className="cmd-group-title">My commands</span><button type="button" className="link-button" onClick={() => openEditor(undefined, "")}><Plus size={12} aria-hidden="true" /> New</button></div>
          {saved.length === 0 && <p className="empty-note">No saved commands. Build one, then press the save icon.</p>}
          {saved.map((item) => (
            <div className="cmd-saved-row" key={item.id}>
              <button type="button" className="cmd-example" title={item.command} onClick={() => setCommand(item.command.replaceAll("{sym}", bot.symbol))}><strong>{item.name}</strong><code>{item.command.replaceAll("{sym}", bot.symbol)}</code></button>
              <button type="button" className="icon-button" title="Edit" onClick={() => openEditor(item.id, item.command, item.name)}><Pencil size={13} aria-hidden="true" /></button>
              <button type="button" className="icon-button" title="Delete" onClick={() => removeSaved(item.id)}><Trash2 size={13} aria-hidden="true" /></button>
            </div>
          ))}
        </div>
      )}

      {showReference && (
        <div className="cmd-reference">
          {COMMAND_REFERENCE.map((group) => (
            <div className="cmd-group" key={group.title}>
              <span className="cmd-group-title">{group.title}</span>
              {group.items.map((item) => (
                <div className="cmd-saved-row" key={item.label}>
                  <button type="button" className="cmd-example" title={item.command} onClick={() => setCommand(item.command.replaceAll("{sym}", bot.symbol))}><strong>{item.label}</strong><code>{item.command.replaceAll("{sym}", bot.symbol)}</code></button>
                  <button type="button" className="icon-button" title="Edit & save a copy" onClick={() => openEditor(undefined, item.command.replaceAll("{sym}", bot.symbol), item.label)}><Pencil size={13} aria-hidden="true" /></button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
