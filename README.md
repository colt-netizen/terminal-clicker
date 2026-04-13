# Terminal Clicker - Smart Multi-Terminal Monitor

Intelligent monitor for Claude agents (and any AI agents) running in terminal windows.

**Key difference from other tools:** This actually READS what's in your terminals, understands what each agent needs, and sends intelligent prompts to keep them moving. Not just dumb key pressing.

## What It Does

For each terminal, the monitor:
1. **Takes a screenshot**
2. **Extracts all visible text** (reads prompts, output, everything)
3. **Analyzes the state** (running? paused? error? stuck?)
4. **Makes intelligent decisions** based on what it sees
5. **Takes action** (press key, type response, send guidance)
6. **Does this for multiple terminals in parallel**

## Quick Start

### See It In Action (Live Demo)

```bash
export OPENAI_API_KEY="sk-..."
python3 smart_terminal_monitor.py
```

This shows you exactly what the monitor sees and decides to do.

### Run the Real Monitor

```bash
python3 launch_daemon.py start --x 640 --y 400 --goal "Deploy code"
```

Monitor runs in background, doesn't block your work.

## Files

- **smart_terminal_monitor.py** - The main intelligent monitor (reads terminals, analyzes, acts)
- **terminal_monitor_daemon.py** - Background daemon version
- **launch_daemon.py** - Start/stop/manage the daemon
- **terminal_clicker.py** - Simple key presser (fallback)

## How It's Different

### ❌ Dumb Monitors
- Timer-based key pressing
- No understanding of terminal state
- Blocks your work
- Can't handle multiple terminals
- Randomly presses keys

### ✅ This Monitor
- Screenshot-based analysis
- **Reads and understands terminal state**
- **Runs in background** (doesn't interfere)
- **Handles multiple terminals** in parallel
- **Makes intelligent decisions** based on what it sees

## Example

Terminal is showing:
```
$ npm test
✗ 5 tests failed

Do you want to retry? (y/n)
```

Monitor:
1. Screenshots and reads: "tests failed, asking to retry"
2. Analyzes: "Agent is paused, needs input"
3. Decides: "Type 'y' and press Enter"
4. Acts: Does it automatically

## Multiple Terminals

```bash
# Monitor left terminal
python3 launch_daemon.py start --x 200 --y 400 --goal "Run tests" &

# Monitor center terminal
python3 launch_daemon.py start --x 640 --y 400 --goal "Deploy code" &

# Monitor right terminal  
python3 launch_daemon.py start --x 1000 --y 400 --goal "Build Docker" &

# All three run in parallel, you keep working
```

## Configuration

Edit terminals in `smart_terminal_monitor.py`:

```python
terminals = {
    "left": {"x": 200, "y": 400, "goal": "Run tests"},
    "center": {"x": 640, "y": 400, "goal": "Deploy code"},
    "right": {"x": 1000, "y": 400, "goal": "Build image"}
}
```

## Requirements

- macOS (uses AppleScript/System Events)
- Python 3.8+
- OpenAI API key (for vision analysis)

## Vision AI Integration

The monitor sends screenshots to OpenAI's GPT-4 Vision for analysis:
- Extracts text from terminal screenshots
- Understands prompts and output
- Analyzes what the agent needs
- Decides what action to take

This is what makes it actually smart (not guessing).

## Logs

Check what happened:
```bash
# View status
python3 launch_daemon.py status

# View logs
python3 launch_daemon.py logs

# View detailed history
cat ~/.terminal_monitor/daemon.log
```

## Use Cases

- Keep Claude Code agents productive while you work on other things
- Manage multiple AI agents running in parallel
- Automate interactive workflows
- Handle long-running deployments with prompts
- Test suite monitoring and intervention

## License

MIT - Free to use and modify

---

**See TEST_SMART_MONITOR.md for detailed testing guide.**
