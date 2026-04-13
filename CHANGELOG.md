# Changelog

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
