# Terminal Clicker

Keep Claude agents (and other AI models) moving in terminal windows by automating clicks and keyboard input.

## The Problem

Claude Code agents get stuck when they hit interactive prompts:
- "Do you want to proceed? (y/n)"
- "Enter password:"
- Menu selections
- Confirmation dialogs

Without manual intervention, agents sit idle indefinitely.

## The Solution

Terminal Clicker automates terminal interaction:
1. Click the terminal window to focus it
2. Press appropriate keys (Enter, arrow keys, etc.)
3. Type text responses (passwords, commands, etc.)
4. Monitor continuously to keep agents alive

## Installation

```bash
# Clone the repo
git clone https://github.com/rochamatthewt/terminal-clicker.git
cd terminal-clicker

# Or just download terminal_clicker.py
curl -O https://raw.githubusercontent.com/rochamatthewt/terminal-clicker/main/terminal_clicker.py
```

## Quick Start

```python
from terminal_clicker import TerminalClicker

# Create clicker at center of screen
tc = TerminalClicker(x=640, y=400)

# Click and press Enter
tc.click_and_press("enter")

# Type text and press Enter
tc.type_and_enter("my_password")

# Monitor: click every 5 seconds for 10 minutes
tc.monitor_and_click(interval=5, duration=600)
```

## Usage Examples

### Single Click
```python
tc = TerminalClicker(x=640, y=400)
tc.click_and_press("enter")
```

### Navigate Menu
```python
tc.click_and_press("down")      # Move down
tc.click_and_press("down")      # Move down again
tc.click_and_press("enter")     # Select
```

### Type Response
```python
tc.type_and_enter("main")  # Type "main" and press Enter
```

### Keep Agent Alive
```python
# Click every 5 seconds for 5 minutes
tc.monitor_and_click(interval=5, duration=300)
```

### Multi-Terminal
```python
left = TerminalClicker(x=200, y=400)
center = TerminalClicker(x=640, y=400)
right = TerminalClicker(x=1000, y=400)

# Monitor all three
for _ in range(60):
    left.click_and_press("enter")
    center.click_and_press("enter")
    right.click_and_press("enter")
    time.sleep(5)
```

## Available Keys

```
"enter"   - Return key
"tab"     - Tab key
"escape"  - Escape key
"space"   - Space bar
"up"      - Up arrow
"down"    - Down arrow
"left"    - Left arrow
"right"   - Right arrow
"delete"  - Delete key
```

## Terminal Positions

Measure pixel position from top-left corner of screen:

```
(200, 400)   - Left third (left terminal)
(640, 400)   - Center (most common)
(1000, 400)  - Right third (right terminal)
```

## Demo

```bash
python3 terminal_clicker.py demo
```

Interactive demo showing all features.

## Integrating with Vision AI

```python
import subprocess
from terminal_clicker import TerminalClicker

tc = TerminalClicker(x=640, y=400)

while True:
    # Screenshot
    subprocess.run("screencapture -x /tmp/terminal.png", shell=True)
    
    # Send to vision AI
    # response = your_vision_api("/tmp/terminal.png", 
    #                            "Is this terminal paused? What key should I press?")
    
    # Act on response
    tc.click_and_press("enter")
    
    time.sleep(5)
```

## Platform Support

### macOS (Recommended)
- Uses AppleScript with System Events
- Most reliable
- No additional dependencies

### Linux
- Use `xdotool` instead (not included, install separately)
- Modify source code to use xdotool commands

### Windows
- Use `pyautogui` library instead
- Install: `pip install pyautogui`
- Modify source code to use pyautogui

## Troubleshooting

**Clicks not working?**
- Verify terminal is visible (not minimized)
- Check x, y coordinates are correct
- Try different coordinates

**Text not typing?**
- Keep text under 100 characters
- Use alphanumeric only
- Use `type_and_enter()` not separate functions

**Terminal not responding?**
- Try clicking multiple times
- Check if another window is on top
- Increase delay in source code (change `delay 0.3` to `delay 0.5`)

## How It Works

Terminal Clicker uses macOS AppleScript's System Events to:
1. Click at a specific screen position
2. Send keyboard events (key codes for special keys, keystrokes for text)
3. Wait for terminal to respond

This bypasses the need for accessibility permissions in most cases.

## License

MIT License - Free to use, modify, and share.

## Author

Built by Colt Rex for keeping Claude agents productive.

## Contributing

Have improvements? Ideas? Open an issue or PR!

---

## Full Documentation

See `EXAMPLES.md` for more advanced patterns and use cases.
