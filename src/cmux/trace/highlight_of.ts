// vscode-port: what the driver highlight marks, from the engine's assigning lines and Trace Driver's
// step (pure: no vscode, so the unit test loads it).
// SPDX-License-Identifier: GPL-3.0-or-later
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Loc { file: string; line: number; endLine?: number }

/** What one highlight marks: the signal, the time, every assigning line, and the active one (file, 1-based lines). */
export interface Highlight {
  signal: string; time: number | null; unit: string;
  all: { file: string; line: number; endLine: number }[];
  active: { file: string; line: number; endLine: number } | null;
  /** (a marker and no driving statement found: why, shown as "driver unknown: <why>"; never silently nothing) */
  unknown?: string;
}

/** The marks for one signal: every assigning line (the engine's assigningLines: assigns, port connections, each
 *  procedure's writes) and, from Trace Driver's step at the marker, the statement that drove it (unless only inferred). */
export function highlightOf(signal: string, lines: Json[], st: Json | null, time: number | null, unit: string): Highlight | null {
  const out: Highlight = { signal, time, unit, all: [], active: null };
  const seen = new Map<string, { file: string; line: number; endLine: number }>();
  const add = (l: Loc | null | undefined) => {
    if (!l || !l.file || !Number(l.line)) { return null; }
    const r = { file: String(l.file), line: Number(l.line), endLine: Number(l.endLine || l.line) };
    const k = r.file + ':' + r.line + ':' + r.endLine;
    if (!seen.has(k)) { seen.set(k, r); out.all.push(r); }
    return seen.get(k)!;
  };
  const procLocs: Loc[] = [];
  const writes: Loc[] = [];
  for (const d of lines || []) {
    if (d.kind === 'proc') { procLocs.push(d.loc); if (d.writes && d.writes.length) { d.writes.forEach((w: Json) => { writes.push(w.loc); add(w.loc); }); } else { add(d.loc); } }
    else { add(d.loc); }
  }
  // (a step whose statement is the procedure as a whole names no line of its own)
  const isProc = (l: Loc) => procLocs.some((p) => p && String(p.file) === String(l.file) && Number(p.line) === Number(l.line) && Number(p.endLine || p.line) === Number(l.endLine || l.line));
  if (st && !st.error && st.stmt && st.stmt.loc && !isProc(st.stmt.loc)) {
    // A statement around the write (a for loop, a case) names its whole range: the active line is the signal's one
    // write inside it (CVA6 `alu_valid_n[i] = 1'b1;` inside `for (...) begin ... end`); with several writes inside, the
    // range stays (the step does not say which ran).
    const s0 = st.stmt.loc as Loc;
    const lo = Number(s0.line), hi = Number(s0.endLine || s0.line);
    const inner = writes.filter((w) => w && String(w.file) === String(s0.file) && Number(w.line) >= lo && Number(w.endLine || w.line) <= hi
      && !(Number(w.line) === lo && Number(w.endLine || w.line) === hi));
    const r = inner.length === 1 ? add(inner[0]) : add(s0);
    // (no marker: no time, so no active line and no note; never "at 0")
    if (r && time !== null && Number.isFinite(time) && st.wrote !== false && !st.inferred) { out.active = Object.assign({}, r); }
  }
  // A marker, but Trace's step failed or named nothing to mark: say so ("driver unknown: <why>") rather than show
  // dim lines as if nothing drove it. (A step that says the procedure did not write it, or only inferred the branch,
  // is an answer: no note.)
  if (out.all.length && time !== null && Number.isFinite(time) && !out.active) {
    if (!st) { out.unknown = 'no step'; }
    else if (st.error) { out.unknown = String(st.message || st.error); }
    else if (st.wrote !== false && !st.inferred) { out.unknown = st.stmt && st.stmt.loc ? 'the whole procedure' : 'no statement'; }
  }
  return out.all.length ? out : null;
}

