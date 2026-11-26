// vscode-port: the slang profile chooser of SystemVerilog editors, ported from cmux's
// SlangProfileActions.swift. A status-bar item "slang: <profile> · top <name>" opens a QuickPick with the workspace's
// profiles (.f build files, listed like cmux: <root>/.slang, ~/.config/cmux-slang/<project>, workspace .f files),
// "Use this file as top level", explore mode, edit / new profile, config warnings and restart.
// Switching uses slang.setBuildFile at runtime: no file written, no restart. Files are written only on an explicit
// choice (new profile, fixing an empty server.json, hiding .slang/ from Git).
// When a waveform opens and slang-server has no design yet, the profile whose --top matches the dump's top scope (or
// the scope below a simulator wrapper) is used, with a "Switched to <profile> to match the waveform" notice and Undo.
// The slang extension (hudson-river-trading.vscode-slang) has its own "slang: Select build file" picker in its project
// view; both send slang.setBuildFile to the same server, so whichever ran last wins. Ours offers to open theirs, and
// never auto-picks while the server already compiles a design (theirs or a config's).
// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import { Slang, SLANG_EXTENSION_ID } from './slang';
import type { WaveformAccess } from './waveform';
import {
  Listing, Profile, listProfiles, settingBuild, buildIn, profileMatchingDumpTops, profileName, moduleAt, newProfileText, addingLine,
  repoProfileDirectory, userProfileDirectory, workspaceRoot, localMarkers, sourcesOutside, CONFIG_RELATIVE_PATH,
} from './profiles';

export interface ProfileHost {
  slang: Slang;
  waveform: WaveformAccess;
  log(s: string): void;
  /** The workspace has SystemVerilog sources (else no slang server is started for an auto-pick). */
  hasSvSources(): Promise<boolean>;
  /** The server now compiles something else: drop design caches, refresh inline values. */
  compilationChanged(): void;
  /** Show Waveform Values For: the dump instances of a module (design + dump path), the one inline values follow, and
   *  choosing one. */
  moduleInstances?(module: string): Promise<{ designInstance: string; dumpInstance: string }[]>;
  chosenInstance?(module: string): string | undefined;
  chooseInstance?(module: string, designInstance: string, dumpInstance: string): void;
}

const SV_EXT = /\.(sv|svh|v|vh|svi|svp)$/i;
export function isSvEditor(e: vscode.TextEditor | undefined): e is vscode.TextEditor {
  return !!e && (SV_EXT.test(e.document.uri.path) || e.document.languageId === 'systemverilog' || e.document.languageId === 'verilog');
}
const HRT_PICKER = 'slang.project.selectBuildFile';
const NOTICE_MS = 15000;

interface AutoPick { profile: string; picked: string; previous: Slang['compilation']; at: number }

export class ProfileChooser implements vscode.Disposable {
  private item = vscode.window.createStatusBarItem('vaporview.slangProfile', vscode.StatusBarAlignment.Left, 50);
  private disposables: vscode.Disposable[] = [];
  private tops: string[] | undefined;
  private autoPick: AutoPick | undefined;
  private autoPickDeclined = false;
  private busy = false;
  /** The running auto-pick (the link's elaborate() waits for it, so it never asks while a profile is applied). */
  autoPickPending: Promise<boolean> | undefined;
  /** Resolves once no auto-pick or profile change is running (at most `ms`): readers of the design (Trace) wait for it. */
  async settled(ms = 30000): Promise<void> {
    const end = Date.now() + ms;
    let seen: Promise<boolean> | undefined;
    while (Date.now() < end) {
      const p = this.autoPickPending;
      // (each pick awaited once, and no longer than the time left)
      if (p && p !== seen) { seen = p; await Promise.race([p.catch(() => false), new Promise((r) => setTimeout(r, Math.max(0, end - Date.now())))]); continue; }
      if (!this.busy) { return; }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  private seenDocs = new WeakSet<object>();
  /** For tests / status: last auto-pick outcome and the label shown. */
  readonly events: string[] = [];

  constructor(private host: ProfileHost) {
    this.item.name = 'slang profile';
    this.item.command = 'vaporview.sourceLink.chooseProfile';
    const reg = (id: string, fn: (...a: any[]) => any) => this.disposables.push(vscode.commands.registerCommand(id, fn));
    reg('vaporview.sourceLink.chooseProfile', () => this.choose());
    reg('vaporview.sourceLink.switchProfile', (a?: vscode.Uri | string) => this.switchTo(a));
    reg('vaporview.sourceLink.useFileAsTopLevel', (a?: vscode.Uri) => this.useFileAsTop(a));
    reg('vaporview.sourceLink.setTopLevelHere', (a?: vscode.Uri) => this.useFileAsTop(a));
    reg('vaporview.sourceLink.resetTopLevel', () => this.resetTopLevel());
    reg('vaporview.sourceLink.useAsBuildFile', (a?: vscode.Uri) => this.useAsBuildFile(a));
    reg('vaporview.sourceLink.clearBuildFile', () => this.clearBuildFile());
    // The server.json route for servers without slang.setBuildFile (tests call it directly; confirmed skips the dialog).
    reg('vaporview.sourceLink.useBuildFileThroughConfig', (f: vscode.Uri | string, confirmed?: boolean) => this.useBuildFileThroughConfig(f instanceof vscode.Uri ? f.fsPath : f, confirmed === true));
    reg('vaporview.sourceLink.showValuesFor', (a?: { module?: string; instance?: string }) => this.showValuesFor(a));
    reg('vaporview.sourceLink.exploreMode', () => this.exploreMode());
    reg('vaporview.sourceLink.editProfiles', () => this.editProfiles());
    reg('vaporview.sourceLink.restartSlang', () => this.restart());
    reg('vaporview.sourceLink.undoProfileAutoPick', () => this.undoAutoPick());
    reg('vaporview.sourceLink.profileStatus', () => this.status());
    this.disposables.push(this.item,
      vscode.window.onDidChangeActiveTextEditor(() => void this.update()),
      vscode.window.tabGroups.onDidChangeTabs((e) => { if (e.opened.some((t) => t.input instanceof vscode.TabInputCustom)) { this.waveformsOpened(); } }),
      vscode.workspace.onDidSaveTextDocument((d) => { if (/\.f$|server\.json$/.test(d.uri.path)) { this.listingCache = undefined; void this.update(); } }),
    );
    void this.update();
    this.setContextKey();
    this.waveformsOpened();
  }

  dispose() { this.disposables.forEach((d) => d.dispose()); }

  // #region Listing
  private listingCache: { root: string; at: number; listing: Listing } | undefined;
  /** The workspace root for `uri` (the editor's file): its workspace folder, else the nearest .slang/.git ancestor. */
  root(uri?: vscode.Uri): string | undefined {
    const u = uri ?? vscode.window.activeTextEditor?.document.uri;
    const folder = (u && vscode.workspace.getWorkspaceFolder(u)) ?? vscode.workspace.workspaceFolders?.[0];
    if (folder?.uri.scheme === 'file') { return folder.uri.fsPath; }
    if (u?.scheme === 'file') { return workspaceRoot(u.fsPath, localMarkers(u.fsPath, os.homedir())); }
    return undefined;
  }
  listing(root = this.root(), force = false): Listing {
    if (!root) { return { profiles: [], configs: [] }; }
    const c = this.listingCache;
    if (!force && c && c.root === root && Date.now() - c.at < 10000) { return c.listing; }
    const listing = listProfiles(root, os.homedir());
    this.listingCache = { root, at: Date.now(), listing };
    return listing;
  }

  // #region Status bar
  private label(): string {
    const c = this.host.slang.compilation;
    let profile: string;
    if (c.target?.kind === 'buildFile') { profile = profileName(c.target.path); }
    else if (c.target) { profile = path.basename(c.target.path); }
    else { profile = c.explore || !(this.tops?.length) ? 'explore' : 'server.json'; }
    const t = this.tops ?? [];
    return t.length ? `slang: ${profile} · top ${t[0]}${t.length > 1 ? ` +${t.length - 1}` : ''}` : `slang: ${profile}`;
  }
  /** Reads the server's tops again (only once it is connected: the item never starts a server) and redraws. */
  async update(readTops = false) {
    // The text is kept current while hidden (e.g. a waveform is the active editor), shown on SV editors only.
    const sv = isSvEditor(vscode.window.activeTextEditor);
    if (readTops || (this.tops === undefined && this.host.slang.mode)) {
      this.tops = (await this.host.slang.getScope('').catch(() => [])).filter((i) => i.kind !== 'Package').map((i) => i.name);
    }
    const warn = this.listing().configs.some((c) => c.health === 'empty' || c.health === 'invalid');
    const notice = this.noticeShown() ? ` (switched to ${this.autoPick!.profile} to match the waveform)` : '';
    this.item.text = `${warn ? '$(warning) ' : ''}${this.label()}${notice}`;
    const c = this.host.slang.compilation;
    this.item.tooltip = [
      'slang profile: click to choose a .f build file, a top level or explore mode',
      c.target ? `${c.target.kind === 'buildFile' ? 'build file' : 'top level'}: ${c.target.path}` : undefined,
      warn ? 'A slang-server config file is empty or unreadable (open the chooser to fix it).' : undefined,
    ].filter(Boolean).join('\n');
    if (sv) { this.item.show(); } else { this.item.hide(); }
  }
  private noticeShown() {
    const a = this.autoPick, c = this.host.slang.compilation;
    return !!a && c.target?.path === a.picked && !c.explore && Date.now() - a.at < NOTICE_MS;
  }

  // #region QuickPick
  async choose() {
    const editor = vscode.window.activeTextEditor;
    const root = this.root();
    const listing = this.listing(root, true);
    type Item = vscode.QuickPickItem & { run?: () => unknown };
    const items: Item[] = [{ label: 'Profiles', kind: vscode.QuickPickItemKind.Separator }];
    const current = this.host.slang.compilation.target;
    if (!listing.profiles.length) { items.push({ label: 'No profiles (.f files) found', description: root ? `in ${repoProfileDirectory(root)}, ${userProfileDirectory(root, os.homedir())} or the workspace` : '' }); }
    for (const p of listing.profiles) {
      const on = current?.kind === 'buildFile' && path.resolve(current.path) === path.resolve(p.path);
      items.push({ label: `${on ? '$(check) ' : ''}${profileName(p)}`, description: p.buildFile.tops.length ? `top ${p.buildFile.tops.join(', ')}` : '', detail: p.path, run: () => this.switchTo(p.path) });
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    if (isSvEditor(editor)) { items.push({ label: '$(symbol-module) Use This File as Top Level', description: path.basename(editor.document.uri.fsPath), run: () => this.useFileAsTop(editor.document.uri) }); }
    items.push({ label: `${this.host.slang.compilation.explore ? '$(check) ' : ''}$(compass) Explore Mode (No Top)`, run: () => this.exploreMode() });
    items.push({ label: '$(edit) Edit Profiles…', run: () => this.editProfiles() });
    for (const c of listing.configs.filter((x) => x.health === 'empty' || x.health === 'invalid')) {
      items.push({ label: `$(warning) ${path.relative(root ?? '', c.path)} is ${c.health === 'empty' ? 'empty' : 'not a JSON object'}`, description: 'slang-server ignores this folder\'s config files', run: () => this.fixConfig(c.path, c.health) });
    }
    if (this.hrtPicker()) { items.push({ label: '$(link-external) slang extension: Select Build File…', description: 'its own picker (build pattern from its config)', run: () => vscode.commands.executeCommand(HRT_PICKER) }); }
    items.push({ label: '$(debug-restart) Restart slang-server', run: () => this.restart() });
    const pick = await vscode.window.showQuickPick(items, { title: this.label(), placeHolder: 'Choose a slang profile (.f build file), a top level or explore mode', matchOnDetail: true });
    await pick?.run?.();
  }

  /** The slang extension's own build-file picker, when it is installed and enabled. */
  private hrtPicker(): boolean {
    return !!vscode.extensions.getExtension(SLANG_EXTENSION_ID) && this.host.slang.mode !== 'own';
  }

  // #region Actions
  private claim(): boolean {
    if (this.busy) { void vscode.window.showWarningMessage('slang: another profile change is still running.'); return false; }
    this.busy = true;
    return true;
  }
  private async designTops(): Promise<string[]> {
    return (await this.host.slang.getScope('').catch(() => [])).filter((i) => i.kind !== 'Package').map((i) => i.name);
  }
  private after() { this.listingCache = undefined; this.host.compilationChanged(); this.setContextKey(); void this.update(true); }
  /** `vaporview.slangTarget` = topLevel | buildFile | explore | '' (menus show Reset Top Level / Clear Build File). */
  setContextKey() {
    const c = this.host.slang.compilation;
    void vscode.commands.executeCommand('setContext', 'vaporview.slangTarget', c.target?.kind ?? (c.explore ? 'explore' : ''));
  }

  /** Builds the design from a profile with slang.setBuildFile; back to what the server compiled when nothing
   *  elaborates. Returns the new tops (empty: failed and restored). */
  private async apply(profile: Profile): Promise<string[]> {
    const previous = this.host.slang.compilation;
    try {
      await this.host.slang.setBuildFile(profile.path);
    } catch (e) {
      this.host.log(`source link: setBuildFile ${profile.path} failed: ${e}`);
      await this.host.slang.restore(previous).catch(() => undefined);
      return [];
    }
    const tops = await this.designTops();
    if (!tops.length) { await this.host.slang.restore(previous).catch(() => undefined); }
    this.tops = tops.length ? tops : undefined;
    this.after();
    return tops;
  }

  async switchTo(arg?: vscode.Uri | string): Promise<string[] | undefined> {
    const file = arg instanceof vscode.Uri ? arg.fsPath : arg;
    const root = this.root();
    const profile = file ? this.listing(root, true).profiles.find((p) => path.resolve(p.path) === path.resolve(file)) ?? (fs.existsSync(file) ? { path: file, buildFile: { tops: [], sources: [], commandFiles: [] } } : undefined) : undefined;
    if (!profile) { return this.choose().then(() => undefined); }
    if (!this.claim()) { return undefined; }
    try {
      if (await this.host.slang.supportsCommand('slang.setBuildFile') === false) {
        void vscode.window.showErrorMessage(`This slang-server can't switch build files while it runs. Set "build": "${profile.path}" in ${CONFIG_RELATIVE_PATH} and restart it.`);
        return undefined;
      }
      this.autoPick = undefined;
      const tops = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `slang: building the design from profile ${profileName(profile)}…` }, () => this.apply(profile));
      this.events.push(`switch ${profileName(profile)} -> ${tops.join(',') || 'nothing'}`);
      if (!tops.length) { void vscode.window.showErrorMessage(`slang-server elaborated nothing from profile ${profileName(profile)}; it keeps what it compiled before.`); return tops; }
      const outside = root ? sourcesOutside(profile.buildFile, root, root) : [];
      const warn = outside.length && outside.length * 2 >= profile.buildFile.sources.length
        ? ` Source files of ${profileName(profile)} are outside ${root} (for example ${outside[0]}), so the files you edit here may not be the ones slang compiles.` : '';
      void vscode.window.showInformationMessage(`slang-server now builds the design from profile ${profileName(profile)} (top ${tops.join(', ')}).${warn}`);
      return tops;
    } finally { this.busy = false; }
  }

  /** Set as SystemVerilog Top Level: the module under the caret (else the file's first). slang elaborates the file's
   *  top; when nothing elaborates, back to what it compiled before. */
  async useFileAsTop(uri?: vscode.Uri): Promise<string[] | undefined> {
    const editor = vscode.window.activeTextEditor;
    const u = uri ?? editor?.document.uri;
    if (!u) { return undefined; }
    const doc = editor && editor.document.uri.toString() === u.toString() ? editor.document : await vscode.workspace.openTextDocument(u);
    const caret = editor && editor.document === doc ? doc.offsetAt(editor.selection.active) : 0;
    const text = doc.getText();
    const module = moduleAt(caret, text)?.name ?? moduleAt(text.search(/\bmodule\b/), text)?.name;
    if (!module) { void vscode.window.showWarningMessage('This file declares no module.'); return undefined; }
    if (!this.claim()) { return undefined; }
    try {
      this.autoPick = undefined;
      const previous = this.host.slang.compilation;
      let tops: string[] = [];
      try { await this.host.slang.setTopLevel(u.fsPath); tops = await this.designTops(); } catch (e) { this.host.log(`source link: setTopLevel ${u.fsPath} failed: ${e}`); }
      if (!tops.length) {
        await this.host.slang.restore(previous).catch(() => undefined);
        this.tops = undefined;
        this.after();
        void vscode.window.showErrorMessage(`slang-server elaborated nothing with ${module} as the top level. If the design needs defines, include directories or files outside this folder, right-click its .f file and choose Use as SystemVerilog Build File instead.`);
        return [];
      }
      this.tops = tops;
      this.after();
      const other = tops.includes(module) ? '' : ` ${module} is instantiated in this file, so slang used ${tops.join(', ')} as the top level.`;
      void vscode.window.showInformationMessage(`slang-server now elaborates ${tops.join(', ')} as the top level.${other}`);
      return tops;
    } finally { this.busy = false; }
  }

  /** Reset Top Level: back to the config's build (if any) or no top. */
  async resetTopLevel(): Promise<boolean> {
    if (this.host.slang.compilation.target?.kind !== 'topLevel' || !this.claim()) { return false; }
    try {
      await this.host.slang.restore({ explore: false });
      this.tops = await this.designTops();
      this.after();
      return true;
    } catch (e) { void vscode.window.showErrorMessage(`Couldn't reset the top level: ${e}`); return false; } finally { this.busy = false; }
  }

  // #region Build file (explorer right-click on a .f)
  /** The server.json edit made for a server without slang.setBuildFile, to put back on Clear Build File. */
  private configEdit: { file: string; previousBuild: string | undefined; existed: boolean } | undefined;

  /** Use as SystemVerilog Build File: slang.setBuildFile at runtime; a server without it gets "build" written to
   *  .slang/local/server.json (after asking) and a restart. */
  async useAsBuildFile(uri?: vscode.Uri): Promise<string[] | undefined> {
    const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!file || !/\.f$/i.test(file)) { void vscode.window.showWarningMessage('Choose a .f build file.'); return undefined; }
    if (await this.host.slang.supportsCommand('slang.setBuildFile') !== false) { return this.switchTo(file); }
    return this.useBuildFileThroughConfig(file);
  }

  async useBuildFileThroughConfig(file: string, confirmed = false): Promise<string[] | undefined> {
    const root = this.root(vscode.Uri.file(file));
    if (!root) { return undefined; }
    const config = path.join(root, CONFIG_RELATIVE_PATH);
    if (!confirmed) {
      const write = 'Write and Restart';
      const pick = await vscode.window.showWarningMessage(`This slang-server can't switch build files while it runs. Set "build" to ${file} in ${config}, keeping the file's other settings, and restart the language server?`, { modal: true }, write);
      if (pick !== write) { return undefined; }
    }
    if (!this.claim()) { return undefined; }
    try {
      const existed = fs.existsSync(config);
      const old = existed ? fs.readFileSync(config, 'utf8') : undefined;
      let next: string;
      try { next = settingBuild(file, old); } catch (e) { void vscode.window.showErrorMessage(`Couldn't use the build file: ${config}: ${(e as Error).message}`); return undefined; }
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, next);
      const previousBuild = this.configEdit?.previousBuild ?? buildIn(old);
      await this.host.slang.restart(false);
      const tops = await this.designTops();
      if (!tops.length) {
        // Put the file back as it was.
        if (existed) { fs.writeFileSync(config, old!); } else { fs.rmSync(config, { force: true }); }
        await this.host.slang.restart(false).catch(() => undefined);
        this.after();
        void vscode.window.showErrorMessage(`slang-server elaborated nothing from ${path.basename(file)}.`);
        return [];
      }
      this.configEdit = { file: config, previousBuild, existed: this.configEdit?.existed ?? existed };
      this.host.slang.compilation = { target: { kind: 'buildFile', path: file }, explore: false };
      this.tops = tops;
      this.after();
      void vscode.window.showInformationMessage(`slang-server now builds the design from ${path.basename(file)} (top ${tops.join(', ')}).`);
      return tops;
    } finally { this.busy = false; }
  }

  /** Clear Build File: back to what the server compiled before (the config's build, or none). */
  async clearBuildFile(): Promise<boolean> {
    if (this.host.slang.compilation.target?.kind !== 'buildFile' || !this.claim()) { return false; }
    try {
      this.autoPick = undefined;
      const edit = this.configEdit;
      if (edit) {
        const cur = fs.existsSync(edit.file) ? fs.readFileSync(edit.file, 'utf8') : undefined;
        if (!edit.existed && edit.previousBuild === undefined && cur !== undefined && Object.keys(JSON.parse(settingBuild(undefined, cur))).length === 0) {
          fs.rmSync(edit.file, { force: true });
        } else { fs.writeFileSync(edit.file, settingBuild(edit.previousBuild, cur)); }
        this.configEdit = undefined;
        this.host.slang.compilation = { explore: false };
        await this.host.slang.restart(false);
      } else {
        await this.host.slang.setBuildFile('');
      }
      this.tops = await this.designTops();
      this.after();
      return true;
    } catch (e) { void vscode.window.showErrorMessage(`Couldn't clear the build file: ${e}`); return false; } finally { this.busy = false; }
  }

  // #region Show Waveform Values For
  /** The dump instances of the module under the caret; picking one makes inline values follow it. */
  async showValuesFor(arg?: { module?: string; instance?: string }): Promise<{ module: string; instances: string[]; chosen?: string } | undefined> {
    const editor = vscode.window.activeTextEditor;
    let module = arg?.module;
    if (!module && isSvEditor(editor)) { module = moduleAt(editor.document.offsetAt(editor.selection.active), editor.document.getText())?.name; }
    if (!module || !this.host.moduleInstances) { void vscode.window.showWarningMessage('Put the caret inside a module.'); return undefined; }
    const all = await this.host.moduleInstances(module);
    if (!all.length) { void vscode.window.showWarningMessage(`No instance of ${module} is in the waveform.`); return { module, instances: [] }; }
    let pick = arg?.instance !== undefined ? all.find((x) => x.dumpInstance === arg.instance || x.designInstance === arg.instance) : undefined;
    if (!pick && arg?.instance === undefined) {
      const cur = this.host.chosenInstance?.(module);
      const item = await vscode.window.showQuickPick(all.map((x) => ({ label: `${x.dumpInstance === cur ? '$(check) ' : ''}${x.dumpInstance}`, description: x.designInstance !== x.dumpInstance ? x.designInstance : '', x })),
        { title: `Show Waveform Values For (${module})` });
      pick = item?.x;
    }
    if (pick) { this.host.chooseInstance?.(module, pick.designInstance, pick.dumpInstance); }
    return { module, instances: all.map((x) => x.dumpInstance), chosen: pick?.dumpInstance ?? this.host.chosenInstance?.(module) };
  }

  async exploreMode() {
    if (!this.claim()) { return; }
    try {
      this.autoPick = undefined;
      await this.host.slang.explore();
      this.tops = [];
      this.after();
      void vscode.window.showInformationMessage('slang-server is in explore mode: it checks each file on its own, with no top level.');
    } catch (e) { void vscode.window.showErrorMessage(`Couldn't switch to explore mode: ${e}`); } finally { this.busy = false; }
  }

  async restart() {
    if (!this.claim()) { return; }
    try {
      this.listingCache = undefined;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'slang: restarting slang-server…' }, () => this.host.slang.restart());
      this.tops = undefined;
      this.after();
      void vscode.window.showInformationMessage('slang-server restarted.');
    } catch (e) { void vscode.window.showErrorMessage(`Couldn't restart the language server: ${e}`); } finally { this.busy = false; }
  }

  // #region Edit / new profiles
  async editProfiles() {
    const profiles = this.listing(this.root(), true).profiles;
    if (!profiles.length) { return this.newProfile(); }
    const items: (vscode.QuickPickItem & { file?: string })[] = profiles.map((p) => ({ label: `Open ${profileName(p)}`, detail: p.path, file: p.path }));
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: '$(add) New Profile…' });
    const pick = await vscode.window.showQuickPick(items, { title: 'Edit slang Profiles' });
    if (!pick) { return; }
    if (pick.file) { await vscode.window.showTextDocument(vscode.Uri.file(pick.file)); return; }
    return this.newProfile();
  }

  /** Asks where to create a profile for the caret's module, writes it there (never over an existing file) and opens
   *  it. Optionally hides .slang/ from Git. */
  async newProfile(choice?: 'repo' | 'repo-hide' | 'user') {
    const root = this.root();
    const editor = vscode.window.activeTextEditor;
    if (!root) { void vscode.window.showWarningMessage('Open a folder to create a slang profile in.'); return; }
    const text = isSvEditor(editor) ? editor.document.getText() : '';
    const caret = isSvEditor(editor) ? editor.document.offsetAt(editor.selection.active) : 0;
    const module = (moduleAt(caret, text) ?? moduleAt(text.search(/\bmodule\b/), text))?.name ?? 'top';
    const repoDir = repoProfileDirectory(root), userDir = userProfileDirectory(root, os.homedir());
    const exclude = gitExcludePath(root);
    if (!choice) {
      const items: (vscode.QuickPickItem & { c: 'repo' | 'repo-hide' | 'user' })[] = [
        { label: 'Create in .slang/', detail: path.join(repoDir, module + '.f'), c: 'repo' },
        ...(exclude ? [{ label: 'Create in .slang/ and hide .slang/ from Git', detail: `adds .slang/ to ${exclude}`, c: 'repo-hide' as const }] : []),
        { label: 'Create in ~/.config/cmux-slang', detail: path.join(userDir, module + '.f'), c: 'user' },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        title: 'New slang Profile',
        placeHolder: `A profile is a slang .f build file (--top, defines, include directories, sources). New: --top ${module} with ${isSvEditor(editor) ? 'this file' : 'no source'}.`,
      });
      if (!pick) { return; }
      choice = pick.c;
    }
    const file = path.join(choice === 'user' ? userDir : repoDir, module + '.f');
    try {
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, newProfileText(module, isSvEditor(editor) ? editor.document.uri.fsPath : `${module}.sv`), { flag: 'wx' });
      }
      if (choice === 'repo-hide' && exclude) {
        const old = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
        const next = addingLine('.slang/', old);
        if (next !== undefined) { fs.mkdirSync(path.dirname(exclude), { recursive: true }); fs.writeFileSync(exclude, next); }
      }
    } catch (e) { void vscode.window.showErrorMessage(`Couldn't create the profile: ${e}`); return; }
    this.listingCache = undefined;
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    return file;
  }

  /** An empty server.json: offer to write {} and restart; an unreadable one: offer to open it. */
  async fixConfig(file: string, health: string) {
    const write = 'Write {} and Restart', open = 'Open File';
    const msg = health === 'empty'
      ? `${file} is empty. slang-server can't read it, so it ignores all of this folder's config files. Write an empty JSON object ({}) to it and restart the language server?`
      : `${file} isn't a JSON object. slang-server can't read it, so it ignores all of this folder's config files. Open it to fix it?`;
    const pick = await vscode.window.showWarningMessage(msg, { modal: true }, ...(health === 'empty' ? [write, open] : [open]));
    if (pick === open) { await vscode.window.showTextDocument(vscode.Uri.file(file)); return; }
    if (pick !== write) { return; }
    try {
      // Only while it is still blank: a config edited since the warning is never replaced.
      if (!/^\s*$/.test(fs.readFileSync(file, 'utf8'))) { void vscode.window.showWarningMessage(`${file} is no longer empty, so it was left unchanged.`); return; }
      fs.writeFileSync(file, '{}\n');
    } catch (e) { void vscode.window.showErrorMessage(`Couldn't fix the config: ${e}`); return; }
    await this.restart();
  }

  // #region Auto-pick
  /** Each newly opened waveform: once its scopes are loaded, auto-pick a profile for it. */
  private waveformsOpened() {
    for (const doc of this.host.waveform.documents()) {
      if (this.seenDocs.has(doc)) { continue; }
      this.seenDocs.add(doc);
      const run = this.autoPickFor(doc).catch((e) => { this.host.log(`source link: profile auto-pick failed: ${e}`); return false; });
      // (the stored promise is the .finally one: compare with it, or autoPickPending never clears)
      const pending: Promise<boolean> = run.finally(() => { if (this.autoPickPending === pending) { this.autoPickPending = undefined; } });
      this.autoPickPending = pending;
    }
    // The viewer's document may only exist a moment after its tab.
    if (!this.retryTimer) { this.retryTimer = setTimeout(() => { this.retryTimer = undefined; if (this.host.waveform.documents().some((d) => !this.seenDocs.has(d))) { this.waveformsOpened(); } }, 1000); }
  }
  private retryTimer: NodeJS.Timeout | undefined;

  private async autoPickFor(doc: Parameters<WaveformAccess['scopeChildren']>[0]): Promise<boolean> {
    if (!vscode.workspace.getConfiguration('vaporview.sourceLink').get<boolean>('autoPickProfile', true)) { return false; }
    const c = this.host.slang.compilation;
    if (c.target || c.explore || this.autoPickDeclined) { return false; }
    const root = this.root();
    // No profiles, or no sources: nothing to compile, and no slang-server is started.
    const profiles = this.listing(root, true).profiles;
    if (!profiles.length || !(await this.host.hasSvSources())) { return false; }
    let topNodes = await this.host.waveform.scopeChildren(doc, []);
    for (let i = 0; i < 300 && !topNodes?.length; i++) { await new Promise((r) => setTimeout(r, 200)); topNodes = await this.host.waveform.scopeChildren(doc, []); }
    const dumpTops = (topNodes ?? []).filter((n) => n.isScope).map((n) => n.name);
    const children: Record<string, string[]> = {};
    for (const t of dumpTops) { children[t] = ((await this.host.waveform.scopeChildren(doc, [t])) ?? []).filter((n) => n.isScope).map((n) => n.name); }
    const profile = profileMatchingDumpTops(dumpTops, children, profiles);
    this.host.log(`source link: profile auto-pick: dump tops ${dumpTops.join(',')} -> ${profile ? profile.path : 'no single match'}`);
    if (!profile || this.busy) { return false; }
    this.busy = true;
    try {
      // The user (or the slang extension, or a config's build) may already have a design: never replace it.
      const c2 = this.host.slang.compilation;
      if (c2.target || c2.explore || this.autoPickDeclined) { return false; }
      if (await this.host.slang.supportsCommand('slang.setBuildFile') === false) { return false; }
      const existing = await this.host.slang.getScope('').catch(() => undefined);
      if (!existing || existing.some((i) => i.kind !== 'Package')) { return false; }
      const previous = this.host.slang.compilation;
      const tops = await this.apply(profile);
      this.events.push(`auto-pick ${profileName(profile)} -> ${tops.join(',') || 'nothing'}`);
      if (!tops.length) { return false; }
      this.autoPick = { profile: profileName(profile), picked: profile.path, previous, at: Date.now() };
      void this.update();
      setTimeout(() => void this.update(), NOTICE_MS + 500);
      void vscode.window.showInformationMessage(`Switched to ${profileName(profile)} to match the waveform.`, 'Undo').then((a) => { if (a === 'Undo') { void this.undoAutoPick(); } });
      return true;
    } finally { this.busy = false; }
  }

  /** Back to what the server compiled before the auto-pick, and no more auto-picks this session. */
  async undoAutoPick(): Promise<boolean> {
    const a = this.autoPick, c = this.host.slang.compilation;
    if (!a || c.target?.path !== a.picked || c.explore || !this.claim()) { return false; }
    try {
      this.autoPick = undefined;
      this.autoPickDeclined = true;
      await this.host.slang.restore(a.previous).catch((e) => this.host.log(`source link: undo auto-pick: ${e}`));
      this.tops = await this.designTops();
      this.events.push(`undo -> ${this.tops.join(',') || 'nothing'}`);
      this.after();
      return true;
    } finally { this.busy = false; }
  }

  status() {
    return {
      label: this.label(), shown: this.item.text, visible: isSvEditor(vscode.window.activeTextEditor),
      compilation: this.host.slang.compilation, tops: this.tops, autoPick: this.autoPick && { profile: this.autoPick.profile, picked: this.autoPick.picked },
      autoPickDeclined: this.autoPickDeclined, events: this.events.slice(), slangMode: this.host.slang.mode, hrtPicker: this.hrtPicker(),
      profiles: this.listing(this.root()).profiles.map((p) => ({ name: profileName(p), path: p.path, tops: p.buildFile.tops })),
      configs: this.listing(this.root()).configs, root: this.root(),
    };
  }
}

/** `git rev-parse --git-path info/exclude` in the root, made absolute; undefined outside a repository. */
function gitExcludePath(root: string): string | undefined {
  try {
    // macOS without the developer tools: /usr/bin/git would ask to install them. Don't.
    if (process.platform === 'darwin') { cp.execFileSync('/usr/bin/xcode-select', ['-p'], { timeout: 3000, stdio: 'ignore' }); }
    const out = cp.execFileSync('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0].trim();
    return out ? (path.isAbsolute(out) ? out : path.join(root, out)) : undefined;
  } catch { return undefined; }
}
