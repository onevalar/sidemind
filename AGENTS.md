# UI components

- All application UI controls use Arc UI. Reuse `src/ui.tsx` or
  `src/components/arc`; do not introduce another general-purpose UI library or
  hand-written button, input, select, menu, dialog, or disclosure control.
- The user's source project is `anvalar/arc-ui`
  (`https://github.com/onevalar/arc-ui`). Read its guidance and copy selected
  components from `custom/arc`, including their CSS and license notices.
  Arc MCP provides component discovery and documentation. Do not overwrite
  existing local adaptations when importing source or updating components.
- Preserve Arc's foundation tokens and each component's visual styling. Do not
  override control/panel radii, typography, borders or shadows merely to imitate
  the previous app. Limit integration styles to app layout and necessary states.
- Search uses Arc CommandPalette as its only visible surface; the bare Dialog
  supplies focus trapping and dismissal without a second frame. The assistant
  uses Arc Pro AI Chat, not AI Composer. Preserve real controlled queries,
  streaming, stop, IME input, and suggestion-as-draft behavior; do not restore
  sample replies or add controls for unsupported demo actions.
- The AI Chat source is Arc Pro, not covered by the free components' MIT notice.
  Do not publish its source as a UI kit, template, package or registry.
- React Flow remains the canvas engine. Milkdown and uiw remain the writing and
  Markdown source engines; their specialized editing/dragging primitives are
  not generic application controls. Surrounding actions still use Arc.
- Preserve single-click selection, double-click editing, Space preview,
  Shift-right-click multi-selection, keyboard movement, and menu focus return.
  The local Arc ContextMenu opens only for right-click or keyboard menu gestures,
  not normal clicks. Do not restore the original template's click-to-open behavior.
