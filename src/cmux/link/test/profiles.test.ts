// vscode-port: unit tests of profiles.ts, mirroring cmux's SlangProfilesTests, SlangTopLevelTests and
// SlangWorkspaceRootTests. Run: npm run test:link-unit
// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseBuildFile, sourcesOutside, listProfiles, profileMatchingDumpTops, configHealth, settingBuild, buildIn,
  NotAJsonObject, ancestors, workspaceRoot, localMarkers, moduleAt, profileName, Profile, quotedBuildFileWord,
  addingLine, newProfileText, CONFIG_RELATIVE_PATH,
} from '../profiles';

const bf = (tops: string[] = [], sources: string[] = []) => ({ tops, sources, commandFiles: [] as string[] });
const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), name));

// #region SlangProfilesTests
test('build file: tops, sources and skipped options', () => {
  const text = [
    '// pipeline build',
    '--top design_a_tb  # wrapper',
    '-I hvl/include +incdir+rtl/inc',
    '+define+FOO=1 -DBAR=2 --std 1800-2017',
    '-f common.f',
    '--top=other_top',
    'rtl/cpu.sv "pkg/my types.sv" /* hvl/old.sv */ hvl/top_tb.sv',
  ].join('\n');
  const f = parseBuildFile(text);
  assert.deepEqual(f.tops, ['design_a_tb', 'other_top']);
  assert.deepEqual(f.commandFiles, ['common.f']);
  assert.deepEqual(f.sources, ['rtl/cpu.sv', 'pkg/my types.sv', 'hvl/top_tb.sv']);
});

test('a backslash at the end of a line continues it', () => {
  const f = parseBuildFile('--top \\\ntb_top +incdir+a \\\nrtl/cpu.sv\r\n');
  assert.deepEqual(f.tops, ['tb_top']);
  assert.deepEqual(f.sources, ['rtl/cpu.sv']);
});

test('a comment ends at a CRLF line end', () => {
  const f = parseBuildFile('// cpu\r\n--top a\r\n# rtl\r\nb.sv\r\n');
  assert.deepEqual(f.tops, ['a']);
  assert.deepEqual(f.sources, ['b.sv']);
});

test('slashes inside paths and escapes stay words', () => {
  const f = parseBuildFile('-DMSG=\\"hi\\" /abs/a.sv\n#comment line\nb.sv');
  assert.deepEqual(f.sources, ['/abs/a.sv', 'b.sv']);
});

test('sources outside the root are reported', () => {
  const f = bf([], ['rtl/cpu.sv', '../../proj-cpu-worktree/rtl/cpu.sv', '/home/u/proj/x.sv', '/home/u/proj0/y.sv']);
  assert.deepEqual(sourcesOutside(f, '/home/u/proj', '/home/u/proj/.slang'), ['/home/u/proj-cpu-worktree/rtl/cpu.sv', '/home/u/proj0/y.sv']);
});

test('a root whose name starts with a dot is searched', () => {
  const base = tmp('slang-dot-');
  const root = path.join(base, '.hidden proj');
  try {
    fs.mkdirSync(path.join(root, 'sim'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sim/w.f'), '--top w_tb\n');
    assert.deepEqual(listProfiles(root, tmp('slang-home-')).profiles.map(profileName), ['w']);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('listing: repo, user folder, user file and workspace .f files; configs with health', () => {
  const base = tmp('slang-profiles-');
  const root = path.join(base, 'my proj');
  const home = tmp('slang-profiles-home-');
  try {
    for (const d of ['.slang', 'sim/deep', '.git', 'node_modules/x']) { fs.mkdirSync(path.join(root, d), { recursive: true }); }
    fs.mkdirSync(path.join(home, '.config/cmux-slang/my proj'), { recursive: true });
    fs.writeFileSync(path.join(root, '.slang/a.f'), '--top a_tb\n');
    fs.writeFileSync(path.join(root, 'sim/deep/w.f'), '--top w_tb\n');
    fs.writeFileSync(path.join(root, '.git/h.f'), '--top hidden\n');
    fs.writeFileSync(path.join(root, 'node_modules/x/n.f'), '--top nm\n');
    fs.writeFileSync(path.join(home, '.config/cmux-slang/my proj/u.f'), '--top u_tb\n');
    fs.writeFileSync(path.join(home, '.config/cmux-slang/my proj.f'), '--top s_tb\n');
    fs.writeFileSync(path.join(root, '.slang/server.json'), '');
    const listing = listProfiles(root, home);
    assert.deepEqual(listing.configs, [{ path: path.join(root, '.slang/server.json'), health: 'empty' }]);
    assert.deepEqual(new Set(listing.profiles.flatMap((p) => p.buildFile.tops)), new Set(['a_tb', 'w_tb', 'u_tb', 's_tb']));
    assert.equal(listing.profiles.length, 4); // hidden folders other than .slang, and node_modules, are not searched
    // Order: repo .slang first, then the user folder, the user file, the workspace.
    assert.deepEqual(listing.profiles.map(profileName), ['a', 'u', 'my proj', 'w']);
    fs.mkdirSync(path.join(root, '.slang/local'));
    fs.writeFileSync(path.join(root, CONFIG_RELATIVE_PATH), '{"build": "a.f", // mine\n}\n');
    assert.deepEqual(listProfiles(root, home).configs.map((c) => c.health), ['empty', 'valid']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('auto-pick matches the dump top or the scope below it', () => {
  const a: Profile = { path: '/r/.slang/a.f', buildFile: bf(['design_a_tb']) };
  const b: Profile = { path: '/r/.slang/b.f', buildFile: bf(['cache_tb']) };
  const stray: Profile = { path: '/r/sim/old.f', buildFile: bf(['cache_tb']) };
  assert.equal(profileMatchingDumpTops(['design_a_tb'], {}, [a, b]), a);
  assert.equal(profileMatchingDumpTops(['TOP'], { TOP: ['cache_tb'] }, [a, b]), b);
  assert.equal(profileMatchingDumpTops(['cache_tb'], {}, [b, stray]), b);
  assert.equal(profileMatchingDumpTops(['nothing'], {}, [a, b]), undefined);
  const twin: Profile = { path: '/r/.slang/c.f', buildFile: bf(['cache_tb']) };
  assert.equal(profileMatchingDumpTops(['cache_tb'], {}, [b, twin]), undefined);
});

test('server config health', () => {
  assert.equal(configHealth(undefined), 'missing');
  assert.equal(configHealth(''), 'empty');
  assert.equal(configHealth(' \n'), 'empty');
  assert.equal(configHealth('[1]'), 'invalid');
  assert.equal(configHealth('{"build":'), 'invalid');
  assert.equal(configHealth('{}'), 'valid');
  assert.equal(configHealth('// flags\n{"flags": "-DX",}'), 'valid');
  assert.equal(configHealth('{"url": "http://x/y", /* c */ "a": [1,2,],}'), 'valid');
});

// #region SlangTopLevelTests
/** The module at the caret marked `|` (the marker is removed first). */
function mod(marked: string): string | undefined {
  const caret = marked.indexOf('|');
  return moduleAt(caret, marked.slice(0, caret) + marked.slice(caret + 1))?.name;
}

test('caret inside or on a module finds it', () => {
  assert.equal(mod('module cpu(input clk);\n  logic |a;\nendmodule\n'), 'cpu');
  assert.equal(mod('mod|ule cpu;\nendmodule\n'), 'cpu');
  assert.equal(mod('module c|pu;\nendmodule\n'), 'cpu');
  assert.equal(mod('  |  module cpu;\nendmodule\n'), 'cpu');
  assert.equal(mod('module cpu;\nendmodul|e\n'), 'cpu');
});

test('caret outside modules finds none', () => {
  assert.equal(mod('module a;\nendmodule\n|\nmodule b;\nendmodule\n'), undefined);
  assert.equal(mod('|// header\nmodule a;\nendmodule\n'), undefined);
  assert.equal(mod('package p;\n  typedef logic |t;\nendpackage\n'), undefined);
});

test('second module of a file', () => {
  assert.equal(mod('module leaf;\nendmodule\nmodule top;\n  leaf |u();\nendmodule\n'), 'top');
});

test('interfaces and programs are not modules', () => {
  assert.equal(mod('interface bus;\n  logic |a;\nendinterface\n'), undefined);
  assert.equal(mod('program p;\n  initial |begin end\nendprogram\n'), undefined);
});

test('comments, strings and defines do not open modules', () => {
  assert.equal(mod('// module fake;\n/* module also_fake; */\nlogic |x;\n'), undefined);
  assert.equal(mod('string s = "module fake;";\nlogic |x;\n'), undefined);
  assert.equal(mod('`define M module fake; \\\n  endmodule\nlogic |x;\n'), undefined);
  assert.equal(mod('module real_one; // endmodule\n  logic |x;\nendmodule\n'), 'real_one');
});

test('nested modules give the innermost', () => {
  const text = 'module outer;\n  module inner;\n    logic |a;\n  endmodule\n  logic b;\nendmodule\n';
  assert.equal(mod(text), 'inner');
  assert.equal(mod(text.replace('|', '').replace('logic b', 'logic |b')), 'outer');
});

test('ifdef second header is the same module', () => {
  const text = '`ifdef X\nmodule m(input a);\n`else\nmodule m(input a, input b);\n`endif\n  logic q;\nendmodule\n|\n';
  assert.equal(mod(text), undefined);
  assert.equal(mod(text.replace('|', '').replace('logic q', 'logic |q')), 'm');
});

test('extern prototypes, lifetimes and escaped names', () => {
  assert.equal(mod('extern module ext(input a);\nlogic |x;\n'), undefined);
  assert.equal(mod('module automatic auto_m;\n  logic |x;\nendmodule\n'), 'auto_m');
  assert.equal(mod('module \\esc.name (input a);\n  logic |x;\nendmodule\n'), 'esc.name');
  assert.equal(mod('macromodule mm;\n  logic |x;\nendmodule : mm\n'), 'mm');
});

test('attributes, numbers and line endings', () => {
  assert.equal(mod('module (* keep *) attr_m;\n  logic |x;\nendmodule\n'), 'attr_m');
  assert.equal(mod("module m;\n  always @(*) y = 8'hff;\n  logic |x;\nendmodule\n"), 'm');
  assert.equal(mod('`define M module fake; \\\r\n  endmodule\r\nlogic |x;\r\n'), undefined);
  assert.equal(mod('module crlf;\r\n  logic |x;\r\nendmodule\r\n'), 'crlf');
  assert.equal(mod('module m; logic [7:0] endmodule_count; |endmodule\n'), 'm');
});

test('unterminated module runs to the end', () => {
  assert.equal(mod('module open_ended;\n  logic a;\n  |'), 'open_ended');
});

test('settingBuild creates the file', () => {
  const data = settingBuild('/w/top.f', undefined);
  assert.deepEqual(JSON.parse(data), { build: '/w/top.f' });
  assert.equal(settingBuild('/w/top.f', '  \n'), data);
  assert.ok(data.includes('"/w/top.f"'));
});

test('settingBuild keeps other keys', () => {
  const existing = '{"flags": "-Wno-unused", "incdirs": ["inc", "rtl/inc"], "build": "/old.f",\n "inlayHints": {"portTypes": true, "funcArgNames": 3}, "indexingThreads": 4}';
  const o = JSON.parse(settingBuild('/new.f', existing));
  assert.equal(o.build, '/new.f');
  assert.equal(o.flags, '-Wno-unused');
  assert.deepEqual(o.incdirs, ['inc', 'rtl/inc']);
  assert.equal(o.indexingThreads, 4);
  assert.deepEqual(o.inlayHints, { portTypes: true, funcArgNames: 3 });
  assert.equal(Object.keys(o).length, 5);
});

test('clearing build removes only it', () => {
  const existing = '{"flags": "-DX", "build": "/old.f"}';
  const cleared = settingBuild(undefined, existing);
  assert.equal(JSON.parse(cleared).build, undefined);
  assert.equal(JSON.parse(cleared).flags, '-DX');
  assert.equal(buildIn(existing), '/old.f');
  assert.equal(buildIn(cleared), undefined);
});

test('an invalid config is not overwritten', () => {
  assert.throws(() => settingBuild('/a.f', '{ not json'), NotAJsonObject);
  assert.throws(() => settingBuild('/a.f', '[1, 2]'), NotAJsonObject);
});

test('new profile text, quoting and git exclude lines', () => {
  assert.equal(quotedBuildFileWord('/a/b.sv'), '/a/b.sv');
  assert.equal(quotedBuildFileWord('/a b/"c".sv'), '"/a b/\\"c\\".sv"');
  const text = newProfileText('cpu', '/w/my rtl/cpu.sv');
  assert.deepEqual(parseBuildFile(text), { tops: ['cpu'], sources: ['/w/my rtl/cpu.sv'], commandFiles: [] });
  assert.equal(addingLine('.slang/', ''), '.slang/\n');
  assert.equal(addingLine('.slang/', '# x'), '# x\n.slang/\n');
  assert.equal(addingLine('.slang/', '# x\n.slang/\n'), undefined);
});

// #region SlangWorkspaceRootTests
const FILE = '/home/u/work/proj/design_a/rtl/cpu.sv';

test('ancestors stop below the filesystem root', () => {
  assert.deepEqual(ancestors('/a/b//c/./x.sv'), ['/a/b/c', '/a/b', '/a']);
  assert.deepEqual(ancestors('/x.sv'), []);
});

test('the nearest server config wins', () => {
  const m = { config: new Set(['/home/u/work/proj/design_a', '/home/u/work']), git: new Set(['/home/u/work/proj/design_a/rtl', '/home/u/work/proj']), home: '/home/u' };
  assert.equal(workspaceRoot(FILE, m), '/home/u/work/proj/design_a');
});

test('git is the fallback', () => {
  assert.equal(workspaceRoot(FILE, { config: new Set(), git: new Set(['/home/u/work/proj', '/home/u/work']), home: '/home/u' }), '/home/u/work/proj');
});

test('home never counts and no marker gives none', () => {
  assert.equal(workspaceRoot(FILE, { config: new Set(['/home/u']), git: new Set(['/home/u']), home: '/home/u/' }), undefined);
  assert.equal(workspaceRoot(FILE, { config: new Set(), git: new Set() }), undefined);
});

test('top-level folders never count', () => {
  const m = { config: new Set(['/home']), git: new Set(['/tmp']), home: '/home/u' };
  assert.equal(workspaceRoot('/tmp/me/mp/rtl/cpu.sv', m), undefined);
  assert.equal(workspaceRoot('/home/u2/x.sv', m), undefined);
  assert.equal(workspaceRoot('/tmp/me/x.sv', { config: new Set(), git: new Set(['/tmp/me']) }), '/tmp/me');
});

test('local markers find .slang/server.json and a .git file', () => {
  const base = tmp('cmux-root-');
  const root = path.join(base, "it's here");
  const rtl = path.join(root, 'rtl');
  try {
    fs.mkdirSync(rtl, { recursive: true });
    fs.mkdirSync(path.join(root, '.slang'));
    fs.writeFileSync(path.join(root, '.slang/server.json'), '{}');
    fs.writeFileSync(path.join(rtl, '.git'), 'gitdir: elsewhere');
    const file = path.join(rtl, 'cpu.sv');
    const m = localMarkers(file, os.homedir());
    assert.ok(m.config.has(root));
    assert.ok(m.git.has(rtl));
    assert.equal(workspaceRoot(file, m), root);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
