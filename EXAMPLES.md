# Examples

Real-world usage patterns for Terminal Clicker.

## Example 1: Simple Yes/No Prompt

Claude agent is stuck at "Do you want to proceed? (y/n)" with "yes" already selected.

```python
from terminal_clicker import TerminalClicker
import time

tc = TerminalClicker(x=640, y=400)

# Just press Enter to confirm
tc.click_and_press("enter")
```

## Example 2: Menu Navigation

Agent is stuck at a menu and needs to select option 3.

```python
tc = TerminalClicker(x=640, y=400)

# Current selection is at option 1
# Press down arrow twice to get to option 3
tc.click_and_press("down")
time.sleep(0.5)
tc.click_and_press("down")
time.sleep(0.5)

# Press Enter to select
tc.click_and_press("enter")
```

## Example 3: Provide Password

Agent is asking for a password.

```python
tc = TerminalClicker(x=640, y=400)

# Type password and press Enter
tc.type_and_enter("my_secure_password")
```

## Example 4: Monitor Single Terminal

Keep a Claude agent alive for 10 minutes, pressing Enter every 5 seconds.

```python
tc = TerminalClicker(x=640, y=400)

# Monitor for 10 minutes (600 seconds), click every 5 seconds
tc.monitor_and_click(interval=5, duration=600)

# This will:
# - Click terminal at (640, 400)
# - Press Enter
# - Wait 5 seconds
# - Repeat until 10 minutes elapsed
# - Stop on Ctrl+C
```

## Example 5: Monitor Three Terminals in Parallel

Running three Claude agents at once (left, center, right).

```python
from terminal_clicker import TerminalClicker
import time
import threading

# Create clickers for each terminal
left = TerminalClicker(x=200, y=400)
center = TerminalClicker(x=640, y=400)
right = TerminalClicker(x=1000, y=400)

def monitor_terminal(tc, name):
    """Monitor a single terminal"""
    print(f"Monitoring {name}...")
    tc.monitor_and_click(interval=5, duration=600)

# Run all three in parallel (threaded)
threads = [
    threading.Thread(target=monitor_terminal, args=(left, "LEFT")),
    threading.Thread(target=monitor_terminal, args=(center, "CENTER")),
    threading.Thread(target=monitor_terminal, args=(right, "RIGHT"))
]

for t in threads:
    t.daemon = True
    t.start()

# Wait for all to finish
for t in threads:
    t.join()
```

## Example 6: Smart Clicking with Vision AI

Use vision AI to understand terminal state, then click intelligently.

```python
import subprocess
import time
from terminal_clicker import TerminalClicker

def analyze_terminal(screenshot_path):
    """Send screenshot to vision AI and get analysis"""
    # In real use, send to your vision API:
    # response = openai.ChatCompletion.create(
    #     model="gpt-4-vision-preview",
    #     messages=[{
    #         "role": "user",
    #         "content": [{
    #             "type": "image_url",
    #             "image_url": {"url": screenshot_path}
    #         }, {
    #             "type": "text",
    #             "text": "Is this terminal paused waiting for input? What should I do next?"
    #         }]
    #     }]
    # )
    # return response.choices[0].message.content
    pass

def smart_click_loop():
    tc = TerminalClicker(x=640, y=400)
    
    for iteration in range(120):  # 10 minutes (120 x 5 seconds)
        # Take screenshot
        subprocess.run("screencapture -x /tmp/tm.png", shell=True)
        
        # Analyze with vision AI
        analysis = analyze_terminal("file:///tmp/tm.png")
        
        # If paused, click and press appropriate key
        if "paused" in analysis.lower():
            print(f"[Iteration {iteration}] Terminal paused, pressing Enter")
            tc.click_and_press("enter")
        else:
            print(f"[Iteration {iteration}] Terminal running, waiting...")
        
        time.sleep(5)

# Run it
smart_click_loop()
```

## Example 7: Interactive CLI

Build an interactive CLI tool for manual terminal control.

```python
from terminal_clicker import TerminalClicker
import sys

def main():
    print("Terminal Clicker - Interactive Mode")
    print("===================================\n")
    
    # Get terminal position from user
    x = int(input("Terminal X position (default 640): ") or "640")
    y = int(input("Terminal Y position (default 400): ") or "400")
    
    tc = TerminalClicker(x=x, y=y, verbose=True)
    
    print("\nCommands:")
    print("  enter              - Click and press Enter")
    print("  <text>             - Type text and press Enter")
    print("  down/up/left/right - Press arrow keys")
    print("  escape             - Press Escape")
    print("  monitor <sec>      - Monitor for N seconds (5s interval)")
    print("  quit               - Exit\n")
    
    while True:
        cmd = input("Terminal> ").strip()
        
        if cmd == "quit":
            break
        elif cmd == "enter":
            tc.click_and_press("enter")
        elif cmd.startswith("monitor"):
            try:
                duration = int(cmd.split()[1])
                tc.monitor_and_click(interval=5, duration=duration)
            except:
                print("Usage: monitor <seconds>")
        elif cmd in ["down", "up", "left", "right", "escape"]:
            tc.click_and_press(cmd)
        else:
            tc.type_and_enter(cmd)

if __name__ == "__main__":
    main()
```

## Example 8: Deployment Automation

Automate responses during a deployment script.

```python
from terminal_clicker import TerminalClicker
import time

def deploy_with_automation():
    tc = TerminalClicker(x=640, y=400)
    
    print("Starting deployment automation...\n")
    
    # Step 1: Wait for "Confirm deployment?"
    print("[1] Waiting for deployment confirmation...")
    time.sleep(10)
    tc.click_and_press("enter")
    
    # Step 2: Wait for "Select branch"
    print("[2] Waiting for branch selection...")
    time.sleep(5)
    tc.type_and_enter("main")  # Deploy main branch
    
    # Step 3: Monitor for "Deployment in progress"
    print("[3] Monitoring deployment progress...")
    tc.monitor_and_click(interval=10, duration=300)  # Monitor for 5 min
    
    print("✓ Deployment automation complete")

if __name__ == "__main__":
    deploy_with_automation()
```

## Example 9: Integration Test Automation

Keep tests alive during long-running test suites.

```python
from terminal_clicker import TerminalClicker
import subprocess
import threading
import time

def run_tests_with_monitoring():
    """Start test suite and keep terminal alive"""
    
    # Terminal running tests
    test_tc = TerminalClicker(x=640, y=400, verbose=False)
    
    # Start test command in background
    test_process = subprocess.Popen(
        ["python", "-m", "pytest", "tests/", "-v"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    
    # Monitor terminal while tests run
    def monitor():
        while test_process.poll() is None:  # While process is running
            test_tc.click_and_press("enter")
            time.sleep(10)
    
    monitor_thread = threading.Thread(target=monitor, daemon=True)
    monitor_thread.start()
    
    # Wait for tests to finish
    test_process.wait()
    
    print("✓ Tests complete")

if __name__ == "__main__":
    run_tests_with_monitoring()
```

## Example 10: Multi-Stage Monitoring

Different actions based on elapsed time.

```python
from terminal_clicker import TerminalClicker
import time

def multi_stage_monitor():
    tc = TerminalClicker(x=640, y=400)
    
    stage = 1
    start = time.time()
    
    while True:
        elapsed = time.time() - start
        
        # Stage 1: First 2 minutes, press Enter every 5 seconds
        if elapsed < 120:
            if elapsed % 5 == 0:
                print(f"[Stage 1] {elapsed}s - Pressing Enter")
                tc.click_and_press("enter")
        
        # Stage 2: 2-5 minutes, press Down arrow periodically (navigate menu)
        elif elapsed < 300:
            if stage != 2:
                print(f"[Stage 2] Transitioning to menu navigation")
                stage = 2
            if elapsed % 10 == 0:
                tc.click_and_press("down")
        
        # Stage 3: 5+ minutes, just monitor (don't click)
        else:
            if stage != 3:
                print(f"[Stage 3] Final monitoring phase")
                stage = 3
            print(f"[Stage 3] {elapsed}s - Just watching")
        
        time.sleep(1)
        
        # Timeout after 10 minutes
        if elapsed > 600:
            print("✓ Timeout reached, stopping")
            break

if __name__ == "__main__":
    multi_stage_monitor()
```

---

See `README.md` for basic usage and API reference.
