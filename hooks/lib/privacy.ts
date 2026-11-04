// Copied from packages/protocol/src by packages/mod/scripts/sync-protocol.mjs. Do not edit here.
// What in a shared turn comes from its runner's own world: their accounts, their computer outside
// the shared project, their screen. Kept with them until they share it (docs/PRIVACY.md).

export type PrivateKind = 'connector' | 'mcp' | 'artifacts' | 'browser' | 'screen' | 'outside' | 'secrets' | 'machine';

export interface PrivateSource {
  /** Stable key for "shared for this space": `connector:Gmail`, `outside`, ... */
  id: string;
  kind: PrivateKind;
  /** Short, for lists and buttons: "Gmail", "Files outside the project". */
  name: string;
  /** For "Share … here?": "your Gmail", "files outside this project". */
  label: string;
}

const ARTIFACT_READS = new Set(['read', 'list', 'get', 'query']);
const SECRET_NAME = /^(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|credentials(\..*)?|secrets?(\..*)?|.*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|ed25519|ecdsa|dsa))$/i;
const SECRET_DIR = /(^|\/)(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.config\/gcloud)(\/|$)/i;
const CREDENTIAL_CMD = /\b(printenv|gh\s+auth\s+token|security\s+find-(generic|internet)-password|op\s+(read|item)|aws\s+configure\s+get|gcloud\s+auth\s+print|az\s+account\s+get-access-token|git\s+credential)\b|(^|[;&|]\s*)env(\s*($|[;&|]))/i;
const HOME_REF = /(^|[\s"'=(])~[A-Za-z0-9._-]*([\\/]|$)|\$\{?(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEPATH|XDG_[A-Z_]+)\b|%(USERPROFILE|APPDATA|LOCALAPPDATA|HOMEPATH|HOMEDRIVE)%|\$env:(HOME|USERPROFILE|APPDATA|LOCALAPPDATA)\b/i;
/** A `..` segment: a path that may climb out of the folder. */
const CLIMBS = /(^|[\\/])\.\.([\\/]|$)/;

/** Forward slashes, no trailing one, except that / and C:/ stay roots. */
const norm = (p: string) => {
  const s = p.replace(/\\/g, '/');
  const t = s.replace(/\/+$/, '');
  return t === '' && s.startsWith('/') ? '/' : /^[a-z]:$/i.test(t) && s.length > t.length ? `${t}/` : t;
};
const isAbs = (p: string) => /^([a-z]:)?\//i.test(p);

/** A path made absolute against the folder, `..` folded; null when it can't be read as a path. */
function resolve(path: string, cwd: string): string {
  let p = norm(path);
  // Git Bash's /c/Users/… for C:/Users/…, when the folder is a Windows one.
  if (/^[a-z]:/i.test(norm(cwd))) p = p.replace(/^\/([a-z])(\/|$)/i, '$1:/');
  const full = isAbs(p) ? p : `${norm(cwd)}/${p}`;
  const out: string[] = [];
  for (const seg of full.split('/')) {
    if (seg === '..') { if (out.length > 1) out.pop(); }
    else if (seg !== '.' && seg !== '') out.push(seg);
    else if (out.length === 0) out.push('');
  }
  return out.join('/');
}

/** Under the shared folder? Case-blind for a Windows drive path. */
export function insideFolder(path: string, cwd: string | undefined): boolean {
  if (!path) return true;
  // ~ and ~name are someone's home.
  if (/^~/.test(path)) return false;
  if (!cwd) return !isAbs(norm(path)) && !norm(path).split('/').includes('..');
  const p = resolve(path, cwd);
  const root = resolve('.', cwd);
  const win = /^[a-z]:/i.test(root);
  const a = win ? p.toLowerCase() : p;
  const b = win ? root.toLowerCase() : root;
  return a === b || a.startsWith(b + '/');
}

function fileSource(path: string, cwd: string | undefined): PrivateSource | null {
  if (!insideFolder(path, cwd)) return OUTSIDE;
  const p = norm(path);
  const base = p.split('/').pop() ?? '';
  if ((SECRET_NAME.test(base) && !/\.pub$/i.test(base) && !/^\.env\.(example|sample|template)$/i.test(base)) || SECRET_DIR.test(p)) return SECRETS;
  return null;
}

const OUTSIDE: PrivateSource = { id: 'outside', kind: 'outside', name: 'Files outside the project', label: 'files outside this project' };
const SECRETS: PrivateSource = { id: 'secrets', kind: 'secrets', name: 'Secret files', label: 'secret files (keys, .env)' };
const MACHINE: PrivateSource = { id: 'machine', kind: 'machine', name: 'Commands outside the project', label: 'your computer outside this project' };

/** "claude_ai_Google_Drive" → "Google Drive"; "plugin_kantban_kantban" → "kantban". */
function serverName(server: string): string {
  let s = server.replace(/^claude_ai_/, '').replace(/^plugin_/, '');
  const parts = s.split('_');
  const half = parts.length % 2 === 0 ? parts.length / 2 : 0;
  if (half && parts.slice(0, half).join('_') === parts.slice(half).join('_')) s = parts.slice(0, half).join('_');
  return s.replace(/_/g, ' ');
}

/**
 * The private source a call reads from, or null when it's the shared work (the project's files
 * and commands), public (web search and fetch) or Multiplayer's own. `cwd`: the turn's folder.
 */
export function privateSource(tool: string, input: unknown, cwd?: string): PrivateSource | null {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (m) {
    const [, server, name] = m;
    if (server === 'multiplayer') {
      // Handing a file to everyone: one outside the project, or a secret, is private like reading it.
      if (name === 'share_file') return fileSource(str('path'), cwd);
      // The person's claude.ai artifacts, lent to the turn: looking at them is reading their account.
      if ((name === 'Artifact' || name === 'ArtifactData' || name === 'ArtifactComments') && ARTIFACT_READS.has(str('action'))) {
        return { id: 'artifacts', kind: 'artifacts', name: 'Artifacts', label: 'your claude.ai artifacts' };
      }
      return null;
    }
    if (/chrome|browser/i.test(server)) return { id: 'browser', kind: 'browser', name: 'Browser', label: 'your browser (and the sites you’re signed in to)' };
    if (/computer[-_]?use|remote-devices/i.test(server)) return { id: 'screen', kind: 'screen', name: 'Screen', label: 'your screen' };
    const nice = serverName(server);
    if (server.startsWith('claude_ai_')) return { id: `connector:${nice}`, kind: 'connector', name: nice, label: `your ${nice}` };
    return { id: `mcp:${nice}`, kind: 'mcp', name: nice, label: `your ${nice} tools` };
  }
  switch (tool) {
    case 'Read': return fileSource(str('file_path'), cwd);
    case 'NotebookEdit': return fileSource(str('notebook_path'), cwd);
    case 'Grep': case 'Glob': {
      const path = str('path');
      if (path) { const s = fileSource(path, cwd); if (s) return s; }
      const pats = [str('glob'), tool === 'Glob' ? str('pattern') : ''].filter(Boolean);
      if (pats.some((p) => /(^|[\s/*{,])\.env\b|id_rsa|\.ssh\/|\.aws\//i.test(p))) return SECRETS;
      // Where a pattern starts searching: its part before any wildcard, under the search path.
      for (const p of pats) {
        // Can't tell where it searches (a `..` past a wildcard, a brace group from elsewhere): private.
        const prefix = p.replace(/[*?[{].*$/, '');
        if (/\.\./.test(p.slice(prefix.length)) || /[{,]\s*(\/|\\|~|[a-z]:)/i.test(p)) return OUTSIDE;
        const fromRoot = isAbs(norm(prefix)) || /^~/.test(prefix);
        if (!prefix || (!fromRoot && !CLIMBS.test(prefix))) continue;
        if (!insideFolder(path && !fromRoot ? `${norm(path)}/${prefix}` : prefix, cwd)) return OUTSIDE;
      }
      return null;
    }
    case 'Bash': case 'PowerShell': {
      const cmd = str('command');
      if (CREDENTIAL_CMD.test(cmd) || HOME_REF.test(cmd)) return MACHINE;
      if (/(^|[\s"'=<>])(\.env\b|[^\s"']*id_(rsa|ed25519)\b(?!\.pub)|[^\s"']*\.ssh\/)/i.test(cmd)) return SECRETS;
      // Any path-like word that lands outside the folder: absolute, from home, or climbing out with `..`.
      // Strict on purpose: anything that might reach past the folder counts as private.
      for (const raw of cmd.split(/[\s"'`|;&<>()=,]+/)) {
        if (!raw || /^(https?|ftps?|wss?):\/\//i.test(raw)) continue;
        let tok = raw;
        // A file: URL is a path, decoded; one naming another computer, or that won't decode, is outside.
        if (/^file:/i.test(tok)) {
          const m = /^file:(\/\/([^/]*))?(.*)$/i.exec(tok)!;
          if (m[2] && !/^(localhost|127\.0\.0\.1)$/i.test(m[2])) return MACHINE;
          try { tok = decodeURIComponent(m[3] || '/'); } catch { return MACHINE; }
        }
        // A drive with no slash after it (C:, C:rel) is that drive's current folder: can't tell.
        if (/^[a-z]:(?![\\/])/i.test(tok)) return MACHINE;
        const abs = /^([a-z]:)?[\\/]/i.test(tok);
        if (!abs && !/^~/.test(tok) && !CLIMBS.test(tok) && tok !== '..') continue;
        if (abs && /^\/dev\/(null|stdout|stderr|tty)$/.test(resolve(tok, '/'))) continue;
        if (!insideFolder(tok, cwd)) return MACHINE;
      }
      return null;
    }
    default: return null;
  }
}

/** The one line others see for a private step: what kind of source, nothing of the call. */
export function privateStepText(src: PrivateSource): string {
  switch (src.kind) {
    case 'connector': return `Used ${src.name}`;
    case 'mcp': return `Used ${src.name} tools`;
    case 'artifacts': return 'Looked at claude.ai artifacts';
    case 'browser': return 'Used the browser';
    case 'screen': return 'Looked at the screen';
    case 'outside': return 'Read a file outside the project';
    case 'secrets': return 'Read a secret file';
    case 'machine': return 'Ran a command that reads outside the project';
  }
}
