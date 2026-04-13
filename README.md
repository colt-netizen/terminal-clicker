# Terminal Clicker

Keep Claude agents moving in terminal windows without interfering with your work.

## 🎯 The Right Way: Background Daemon

**Don't run a blocking monitor.** Use the **background daemon** that:
- ✅ Runs in background (doesn't block your work)
- ✅ Pauses when you're actively using computer
- ✅ Only acts on terminals when they're paused
- ✅ You can start/stop anytime
- ✅ Logs everything

```bash
# Start daemon (runs in background, doesn't block)
python3 launch_daemon.py start --x 640 --y 400 --goal "Deploy code"

# Check status while working
python3 launch_daemon.py status

# View logs
python3 launch_daemon.py logs

# Stop when done
python3 launch_daemon.py stop
```

---

## How It Works

```
Background Daemon (doesn't block you)
  ↓
Every 5 seconds:
  - Takes screenshot (non-blocking)
  - Checks if you're using computer
    - If YES: pauses, waits
    - If NO: analyzes terminal with vision AI
  - If agent paused/stuck: acts (press key, type, send guidance)
  - If agent running: waits
  ↓
Logs everything to ~/.terminal_monitor/
```

The key: **It pauses when you're working** so it doesn't interfere.

---

## Installation

```bash
git clone https://github.com/colt-netizen/terminal-clicker.git
cd terminal-clicker

# Requires OPENAI_API_KEY for smart analysis
export OPENAI_API_KEY="sk-..."
```

---

## Quick Start

### Start the daemon

```bash
python3 launch_daemon.py start \
  --x 640 \
  --y 400 \
  --goal "Deploy the latest code and report status"
```

That's it. Now it runs in background. You can:
- Work on other stuff
- Close the terminal
- Use your computer normally

The daemon keeps monitoring without interfering.

### Check status

```bash
python3 launch_daemon.py status
```

Output:
```
✅ Daemon running
   Status: monitoring
   Iteration: 42
   Last update: 2025-04-12T22:45:30
```

### View logs

```bash
python3 launch_daemon.py logs --tail 20
```

### Stop daemon

```bash
python3 launch_daemon.py stop
```

---

## What the Daemon Does

### When Agent is Running
```
→ Takes screenshot
→ Analyzes: "Agent running, don't interrupt"
→ Waits 5 seconds
→ Repeats
```

### When Agent is Paused
```
→ Takes screenshot
→ Analyzes: "Agent paused at 'Do you want to proceed?'"
→ Presses Enter
→ Waits 5 seconds
→ Checks again
```

### When Agent Asks for Input
```
→ Takes screenshot
→ Analyzes: "Agent asking 'Which branch?' - needs input"
→ Types "main" and presses Enter
→ Waits 5 seconds
→ Checks again
```

### When Agent Hits Error
```
→ Takes screenshot
→ Analyzes: "Error detected - recoverable"
→ Presses Enter to retry
→ Waits 5 seconds
→ If error again: escalates (stops and alerts you)
```

---

## Configuration

### Terminal Position

Find your terminal's pixel position (from top-left):

```bash
# Center of screen (default)
python3 launch_daemon.py start --x 640 --y 400

# Left third
python3 launch_daemon.py start --x 200 --y 400

# Right third
python3 launch_daemon.py start --x 1000 --y 400
```

### Goal (what agent is trying to do)

```bash
python3 launch_daemon.py start \
  --x 640 \
  --y 400 \
  --goal "Run integration tests and report results"
```

Agent's goal helps vision AI understand context better.

---

## How It Pauses for Your Work

The daemon detects if you're actively using the computer:
- Watches mouse movement
- Pauses if you move mouse (you're working)
- Resumes after 5 seconds of inactivity

So you can:
- Type commands
- Click around
- Work normally
- Daemon waits for you to stop, then monitors again

---

## Logs

All monitoring is logged to `~/.terminal_monitor/`

```
daemon.log           - Main log
status.json          - Current status
last_screenshot.png  - Last screenshot taken
monitor_*.jsonl      - Detailed monitoring history
```

### View recent logs

```bash
# Last 50 lines
python3 launch_daemon.py logs

# Last 100 lines
python3 launch_daemon.py logs --tail 100

# All logs
cat ~/.terminal_monitor/daemon.log
```

### Analyze detailed history

```bash
# See all actions taken
cat ~/.terminal_monitor/monitor_*.jsonl | jq .

# See only errors
cat ~/.terminal_monitor/monitor_*.jsonl | jq 'select(.level=="ERROR")'

# See status changes
cat ~/.terminal_monitor/monitor_*.jsonl | jq 'select(.message | contains("Status"))'
```

---

## Comparison: Blocking vs Daemon

### ❌ Blocking (old way)
```python
monitor = SmartTerminalMonitor(...)
monitor.run(duration=600)  # Takes over your screen for 10 minutes
```

Problem: You can't do anything while it's running.

### ✅ Daemon (right way)
```bash
python3 launch_daemon.py start
# You can keep working!
```

Benefit: Daemon monitors in background, you keep working.

---

## Examples

### Deploy code while you work

```bash
# Start daemon
python3 launch_daemon.py start \
  --x 640 --y 400 \
  --goal "Deploy latest code to production and report status"

# Now work on other stuff
# Daemon monitors deployment in background
# Check progress anytime: python3 launch_daemon.py status

# When done
python3 launch_daemon.py stop
```

### Run tests and monitor

```bash
python3 launch_daemon.py start \
  --x 640 --y 400 \
  --goal "Run full test suite and report results"

# Keep working...
# Daemon handles interactive prompts automatically
```

### Multiple terminals

```bash
# Monitor left terminal
python3 launch_daemon.py start --x 200 --y 400 --goal "Task 1" &

# Monitor center terminal
python3 launch_daemon.py start --x 640 --y 400 --goal "Task 2" &

# Monitor right terminal
python3 launch_daemon.py start --x 1000 --y 400 --goal "Task 3" &

# All three run in background, you can work normally
```

---

## Troubleshooting

### Daemon not responding

```bash
# Check status
python3 launch_daemon.py status

# View logs
python3 launch_daemon.py logs

# Restart
python3 launch_daemon.py restart
```

### Not detecting agent state correctly

The daemon uses vision AI (OpenAI). Make sure:
```bash
echo $OPENAI_API_KEY  # Should have a key
```

Without API key, daemon runs in "mock mode" (doesn't actually help).

### Daemon interfering with your work

That means `pause_on_activity` isn't working. The daemon should pause when you move your mouse.

If it's not, you can:
```bash
python3 launch_daemon.py stop
# Then restart
```

---

## Advanced: Custom Start Script

Instead of command line, create a script:

```bash
#!/bin/bash
# deploy_with_monitoring.sh

# Start daemon
python3 launch_daemon.py start \
  --x 640 --y 400 \
  --goal "Deploy code to production"

# Run deployment in the terminal
# Daemon monitors in background

# When deployment finishes (or after timeout)
sleep 600
python3 launch_daemon.py stop
```

---

## API Key Setup

```bash
# Get key from https://platform.openai.com/api-keys
export OPENAI_API_KEY="sk-..."

# Add to ~/.bashrc or ~/.zshrc to persist
echo 'export OPENAI_API_KEY="sk-..."' >> ~/.bashrc
source ~/.bashrc
```

---

## License

MIT - Free to use and modify

---

## Questions?

Check the logs: `cat ~/.terminal_monitor/daemon.log`

Or view examples in EXAMPLES.md
