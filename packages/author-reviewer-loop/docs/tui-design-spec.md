# Spar TUI Design Spec

This document is the source of truth for Spar's TUI chrome and startup UX.

## Chrome Hierarchy

- The always-visible footer is for primary navigation only: current round, round movement, pane scroll, pane focus, and quit.
- Advanced or low-frequency controls must stay in the help overlay, not in the always-visible footer.
- Advanced controls include trace, tool selection/detail, task edit/view, wrap toggle, jump latest, force continue, and startup/error detail affordances.
- State badges in the footer must not advertise advanced modes such as `trace:on`, `trace:off`, `wrap:on`, or `wrap:off`.

## Help Overlay

- The help overlay lists all available keybindings, including advanced controls.
- Moving an advanced control out of the footer must not disable the keybinding.
- `?` remains the discoverability path for advanced controls.

## Startup And Confirmation Screens

- Setup, confirmation, and task-editor waiting screens are static screens.
- These screens must not run title wait animations, chrome patch animations, or animated spinner text.
- Setup and confirmation screens should show only information needed to start the run.
- Diagnostic details such as ACP trace state must not be shown on the launch confirmation screen.

## Runtime Header And Animation

- The top runtime header may animate the Spar boxing-glove brand row while agents are launching.
- Runtime header animation must not leak into setup, confirmation, task editor, cancelled, or finishing screens.
- Brand-row truncation must never render stray ellipsis dots next to the right glove.

## Terminal Title

- The terminal title should stay compact: Spar state plus round when useful.
- It must not include active role names such as AUTHOR or REVIEWER.

## User Configuration

- Spar-owned user files must live under the ACP Kit home directory `~/.acp-kit/spar`.
- The default preferences file is `~/.acp-kit/spar/preferences.json`.
- Startup profiling is enabled by default and writes to `~/.acp-kit/spar/startup-profile.log`.
- New preference writes must target `~/.acp-kit/spar/preferences.json`, not a separate top-level home directory.

## Fitted Pane Titles

- Pane titles may truncate agent or model labels to fit narrow panes.
- Model labels are bracketed UI tokens and must preserve the closing parenthesis when truncated, e.g. `(gpt...)`.
