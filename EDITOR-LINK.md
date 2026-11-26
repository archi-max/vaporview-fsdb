# Editor link: designs and profiles

This page covers the editor link's slang profiles and workspaces with several designs. Setup is in the README,
under [Editor link setup](README.md#editor-link-setup).

slang-server is not bundled because it would add about 30 MB per platform. The link was tested with slang-server
0.3.1 on macOS and Linux, both through the slang extension and on its own.

## Several designs

Each design has its own root: the nearest folder with `.slang/server.json`, else the workspace folder that holds the
file (only then the `.git` folder). The workspace folder comes before `.git` on purpose: in a workspace folder inside a
larger repository, `.git` would make slang index the whole repository. The link runs one slang connection per root and sends each SystemVerilog file, and each waveform,
to its design's root (a waveform goes to the root of the editor it was linked from, else the root that holds the dump
file, else the root whose design has the dump's top modules). The slang extension runs one language server for the whole
window and resolves its paths against the first workspace folder, so only the first folder's design uses it; the link
starts its own slang-server for every other root (put `slang-server` on PATH or set
`vaporview.sourceLink.slangServerPath`). Waveform Path Mapping… rules are kept per design root and dump (file name and
top scopes); the `vaporview.sourceLink.pathMapping` setting is the default for dumps without rules of their own.

## Slang profiles

A SystemVerilog editor shows **slang: &lt;profile&gt; · top &lt;module&gt;** in the status bar. Click it (or run
**slang: Choose Profile…** from the Command Palette or the editor's context menu) to pick:

- a **profile**: a slang `.f` build file (`--top`, defines, include directories, sources). Profiles are listed from
  `<folder>/.slang/*.f`, the per-user profile folder (`~/.config/cmux-slang/<folder name>/*.f` or
  `~/.config/cmux-slang/<folder name>.f`, for profiles you keep outside the repository; the folder name is inherited
  from the cmux terminal, where this editor link started) and other `.f` files up to 4 levels into the folder.
  Relative paths in a profile resolve against the workspace folder;
- **Use This File as Top Level**, or **Explore Mode** (no top: each file checked on its own);
- **Edit Profiles…** (open one, or create one for the module at the caret in `.slang/` or the per-user profile
  folder `~/.config/cmux-slang`, optionally adding `.slang/` to `.git/info/exclude`);
- a fix for an empty or unreadable `.slang/server.json` (slang-server then ignores all of the folder's configs);
- **Restart slang-server**.

Switching sends `slang.setBuildFile` to the running server: nothing is written and nothing restarts. Files are written
only when you create a profile, fix an empty config or hide `.slang/` from Git.

When you open a waveform and slang-server has no design yet, the link picks the profile whose `--top` names the
waveform's top scope (or the scope just below a simulator wrapper such as `TOP`). It tells you "Switched to
&lt;profile&gt; to match the waveform", with **Undo** (or run **slang: Undo Profile Auto-Pick**). It never replaces a
design the server already compiles. Turn it off with `vaporview.sourceLink.autoPickProfile`.

**With the slang extension:** its Project view has its own **slang: Select build file** picker (driven by its
`buildPattern` config). Both pickers send `slang.setBuildFile` to the same server, so the last choice wins. Ours
lists the `.f` files above, and its menu has an entry that opens the extension's picker. Ours never auto-picks
while a design is loaded, including one chosen in the extension's picker.

**Several designs in one window:** the chooser works on one design root at a time: the root of the active editor's
file (else the first folder's root), and auto-pick uses the waveform's design root. Switching the profile in one
folder leaves the other folders' designs as they are.
