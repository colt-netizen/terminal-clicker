# Changelog

## Unreleased

### Added
- mlb-multiview-switcher 0.2.0: game-state awareness. Tracks every game via
  MLB's free public stats API plus the page's own game rail ("Bot 8", "Final",
  start times), ranks games by user team priorities, keeps audio on live
  baseball only, and auto-tunes panes showing dead games to live ones by
  driving the rail — with verified attempts and automatic stand-down when rail
  clicks don't land. No AI, no keys, ~5KB/45s only while an MLB tab is open.
- `mlb-multiview-switcher/` — a Chromium MV3 extension, independent of the
  Python tooling. Watches an MLB.tv multiview tab and promotes another pane
  when the one carrying audio goes quiet. Detection uses Chrome's per-tab
  `audible` flag rather than a Web Audio analyser, because MLB.tv is Widevine
  protected. See `mlb-multiview-switcher/README.md`.

## [1.0.0] - 2025-04-12

### Added
- Initial release
- `TerminalClicker` class with click and keyboard control
- `click_and_press()` - Click terminal and press a key
- `type_and_enter()` - Type text and press Enter
- `click()` - Just click (no key press)
- `press_key()` - Press key without clicking first
- `monitor_and_click()` - Continuous monitoring mode
- `set_position()` - Update terminal position
- Support for 9 key codes (Enter, Tab, Escape, Space, Arrows, Delete)
- Demo mode with interactive examples
- Comprehensive documentation and examples
- MIT License

### Tested On
- macOS 13+ (Ventura, Sonoma)
- Python 3.8+
- Works with Claude Code agents and other AI assistants

### Known Limitations
- macOS only (AppleScript/System Events)
- Text input limited to 100 characters for safety
- Requires terminal window to be visible
- No accessibility permissions required on recent macOS versions
