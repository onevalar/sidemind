# Arc UI in ChatGit

Source: `onevalar/arc-ui`, `custom/arc`, snapshot
`fd56e8e37a3194a2a03270b090371a85aefc9c18`.

ChatGit adapts selected **Free / MIT** components, not the complete source archive.
No Arc Pro files, demo responders, fake saves, account pages or Next.js runtime
are included. The source repository's `upstream/` and `custom/` remain untouched.

## Product constraints

- ChatGit is a locally launched desktop service. Desktop windows are the design
  and acceptance target; narrow-screen redesign is not part of this migration.
- Chinese and English are supported UI languages. New workspace copy must ship
  in English, Simplified Chinese and Traditional Chinese, including error states.
- Appearance offers System, Light and Dark only. Legacy high-contrast choices
  migrate to the corresponding plain scheme. Preserve readable text, keyboard
  focus and native OS forced colors without adding an app high-contrast palette.
- Local entry uses the launcher, not a ChatGit registration flow. Optional model
  provider authorization is separate from opening ChatGit itself.

## Adaptations

- `segmented-control/segmented-control.tsx` and its CSS →
  `client/src/components/ui/SegmentedControl.tsx`: controlled selection, shared
  highlight and keyboard navigation. Uses installed Framer Motion, semantic
  Tailwind tokens, a 44px target and RTL-aware arrows. No new package is required.
- `foundation.css` → the versioned theme in `chatgit.yaml`: neutral light/dark
  surfaces, control sizing, nested radii and resting/floating shadows. Arc's raw
  global variables and focus reset are not imported. Text and control contrast
  take precedence over literal reproduction of the palette.
- `button/button.module.css`, `input/input.module.css` and
  `dialog/dialog.module.css` inform the existing shared primitives' surface,
  focus and disabled treatments. Their public props, refs, form semantics,
  menus, nested dialogs and focus restoration stay intact.

These changes are the first migration slice, not a replacement of every
LibreChat control. Further Arc components must be adapted against React 18 and
the existing theme/interaction contracts before adoption. Keep the conversation,
streaming, Markdown, authentication and React Flow implementations authoritative.

## Canvas UI: the full Arc source (2026-10-12)

The canvas UI in `app/web/` is built entirely on Arc. `app/web/src/components/arc/` is a copy of the private
`onevalar/arc-ui` repository's `custom/arc/` at `fd56e8e37a3194a2a03270b090371a85aefc9c18`, **including Pro
components**. Pro source may only live in private repositories: keep `chat-git` private, and never publish a package,
template or registry that contains it. Update by copying `custom/arc/` again and re-applying the changes below.

ChatGit changes to that copy (kept minimal and backward compatible):

- `copy-button`: optional `messages` (`copied`, `failed`, `couldNotCopy`) so the visible status is translated.
- `inline-edit`: optional `messages` (`activate`, `saveCancel`, `saveNewlineCancel`) for the screen-reader hints.

Arc has no branching-graph canvas (`data-flow` is a fixed pipeline animation, `semantic-zoom` is bound to its demo
data and has no edges), so the canvas layer is drawn by ChatGit with Arc's design variables. Arc buttons never
truncate their label, so long-title list rows (canvas list, branch list) are native buttons on Arc variables.
Some Arc components still contain English screen-reader text (for example toast type names).

## MIT License

Copyright (c) 2026 Elia Kuratli

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
