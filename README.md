# Terminal Clicker

Keep Claude agents moving in terminal windows by automating clicks and keyboard input.

## ⚠️ IMPORTANT: Two Versions

### 1. **Simple Clicker** (`terminal_clicker.py`)
```python
tc = TerminalClicker(x=640, y=400)
tc.click_and_press("enter")  # Dumb key pressing
tc.monitor_and_click(interval=5, duration=600)  # Blind timer
```
**Use for:** Quick automation where you just need to press keys repeatedly

### 2. **Smart Monitor** (`smart_terminal_monitor.py`) ⭐ RECOMMENDED
```python
monitor = SmartTerminalMonitor(
    terminal_position=(640, 400),
    agent_goal="Deploy code and report status"
)
monitor.run(duration=600, check_interval=5)  # Vision AI powered
```
**Use for:** Actually managing Claude agents - takes screenshots, understands state, makes intelligent decisions

---

## The Difference

| Feature | Simple Clicker | Smart Monitor |
|---------|---|---|
| How it works | Timer → Press key | Screenshot → Vision AI → Decide → Act |
| Understands state? | ❌ No | ✅ Yes |
| Detects errors? | ❌ No | ✅ Yes |
| Adapts to situation? | ❌ No | ✅ Yes |
| Guides stuck agents? | ❌ No | ✅ Yes |
| Logs decisions? | ❌ No | ✅ Yes |
| Escapes infinity loops? | ❌ No | ✅ Yes |

---

## Installation

```bash
git clone https://github.com/colt-netizen/terminal-clicker.git
cd terminal-clicker
```

### For Smart Monitor (Recommended)

```bash
# Set your OpenAI API key
export OPENAI_API_KEY="sk-..."

# Run the smart monitor
python3 smart_terminal_monitor.py
```

### For Simple Clicker

```bash
# Just run it
python3 terminal_clicker.py demo
```

---

## Quick Start - Smart Monitor

```python
from smart_terminal_monitor import SmartTerminalMonitor
import os

# Get API key
api_key = os.environ.get("OPENAI_API_KEY")

# Create monitor
monitor = SmartTerminalMonitor(
    terminal_position=(640, 400),
    agent_goal="Deploy the latest code to production",
    vision_api_key=api_key
)

# Run for 10 minutes, checking every 5 seconds
monitor.run(duration=600, check_interval=5)
```

The monitor will:
1. **Take a screenshot every 5 seconds**
2. **Send to vision AI** (OpenAI GPT-4 Vision)
3. **Understand the current state** (running, paused, error, blocked, complete)
4. **Make intelligent decisions:**
   - If agent paused → press appropriate key
   - If agent asking for input → provide response
   - If error → retry if safe, escalate if not
   - If stuck → send guidance to agent
   - If running → don't interrupt
5. **Log everything** to `~/terminal_monitor.jsonl`

---

## How Smart Monitor Works

### The Loop

```
Screenshot → Vision AI Analysis → Parse Response → Make Decision → Act → Wait → Repeat
```

### Example Scenario

**Agent is stuck deploying code:**

```
1. Screenshot shows: "ERROR: Connection timeout, retry? (y/n)"
2. Vision AI says: "Status=ERROR, Recoverable, recommend=Retry"
3. Smart Monitor decides: "Error is recoverable, press Enter to retry"
4. Monitor acts: Presses Enter
5. Agent retries and succeeds
```

**Agent is asking for input:**

```
1. Screenshot shows: "Which environment? (dev/staging/prod)"
2. Vision AI says: "Status=PAUSED, recommend=Type 'prod'"
3. Smart Monitor decides: "Type 'prod' and press Enter"
4. Monitor acts: Types response
5. Agent continues with production deployment
```

**Agent is running but stuck:**

```
1. Screenshot shows: Command running, no prompt
2. Vision AI says: "Status=BLOCKED, not making progress"
3. After 3 checks, Smart Monitor decides: "Send guidance"
4. Monitor acts: Sends "Next step toward goal: [what to do next]"
5. Agent receives guidance and gets unstuck
```

---

## Configuration

### Terminal Position

Find your terminal's position (pixels from top-left):

```python
# Center of screen (most common)
terminal_position=(640, 400)

# Left third (left terminal)
terminal_position=(200, 400)

# Right third (right terminal)
terminal_position=(1000, 400)
```

### Check Interval

```python
# Very frequent monitoring (every 2 seconds)
monitor.run(duration=600, check_interval=2)

# Normal (every 5 seconds)
monitor.run(duration=600, check_interval=5)

# Less frequent (every 10 seconds)
monitor.run(duration=600, check_interval=10)
```

### Duration

```python
# Monitor for 5 minutes
monitor.run(duration=300)

# Monitor for 30 minutes
monitor.run(duration=1800)

# Monitor indefinitely (until task completes or error)
monitor.run(duration=86400)  # 24 hours
```

---

## Vision AI Setup

### OpenAI (Recommended)

1. Get API key from https://platform.openai.com/api-keys
2. Export it:
   ```bash
   export OPENAI_API_KEY="sk-..."
   ```
3. Smart monitor uses it automatically

### Claude / Anthropic (Future)

Will work with Claude's vision API when integrated:

```python
monitor = SmartTerminalMonitor(
    vision_model="claude-vision",
    vision_api_key=anthropic_key
)
```

---

## Logs

Every decision is logged to `~/terminal_monitor.jsonl`:

```json
{"timestamp": "2025-04-12T22:45:30", "iteration": 1, "action": "pressed_enter", "status": "PAUSED_PROMPT"}
{"timestamp": "2025-04-12T22:45:35", "iteration": 2, "action": "wait", "status": "RUNNING"}
{"timestamp": "2025-04-12T22:45:40", "iteration": 3, "action": "typed_response", "status": "PAUSED_PROMPT"}
```

Analyze with:

```bash
# See all actions
cat ~/terminal_monitor.jsonl | jq .

# See only errors
cat ~/terminal_monitor.jsonl | jq 'select(.action | contains("error"))'

# Count actions
cat ~/terminal_monitor.jsonl | jq -s 'group_by(.action) | map({action: .[0].action, count: length})'
```

---

## Troubleshooting

### "No OPENAI_API_KEY set"

```bash
export OPENAI_API_KEY="sk-your-key-here"
python3 smart_terminal_monitor.py
```

### Terminal clicks not working

- Verify terminal is visible and at correct position
- Check (x, y) coordinates are correct
- Try adding delay: modify script, increase `delay` from 0.3 to 0.5

### Vision AI errors

- Check API key is valid
- Ensure you have API credits
- Check network connection
- Try again (API timeouts are temporary)

---

## Examples

See `EXAMPLES.md` for:
- Multi-terminal monitoring
- Custom guidance prompts
- Integration with your agent workflow
- Error handling patterns
- Deployment automation

---

## When to Use Smart Monitor

✅ Claude agents in terminals
✅ Long-running tasks
✅ Interactive workflows (need input)
✅ Error-prone deployments
✅ Multi-step processes

❌ Simple key pressing (use Simple Clicker)
❌ No vision API available (use Simple Clicker)
❌ Tasks that never need input (use Simple Clicker)

---

## License

MIT - Free to use, modify, share

---

## Questions?

Check EXAMPLES.md for more patterns or open an issue on GitHub.
