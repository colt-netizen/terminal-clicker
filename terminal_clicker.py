#!/usr/bin/env python3
"""
Terminal Clicker - Keep Claude agents moving in terminal windows

This script provides simple functions to automate clicking terminals and pressing keys.
Perfect for keeping Claude agents alive when they get stuck on interactive prompts.

Usage:
    python3 terminal_clicker.py
    
    Or import as module:
    from terminal_clicker import TerminalClicker
    tc = TerminalClicker(x=640, y=400)
    tc.click_and_press_enter()
"""

import subprocess
import time
import sys
from pathlib import Path


class TerminalClicker:
    """
    Simple terminal clicker for keeping Claude agents moving.
    
    Attributes:
        x, y: Screen position of terminal window (pixels from top-left)
    """
    
    # Key code map (macOS)
    KEY_CODES = {
        "enter": 36,
        "return": 36,
        "tab": 48,
        "esc": 53,
        "escape": 53,
        "space": 49,
        "up": 126,
        "down": 125,
        "left": 123,
        "right": 124,
        "delete": 51,
    }
    
    def __init__(self, x=640, y=400, verbose=True):
        """
        Initialize with terminal position.
        
        Args:
            x: Horizontal position in pixels (default: center of screen)
            y: Vertical position in pixels (default: middle of screen)
            verbose: Print actions to console
        """
        self.x = x
        self.y = y
        self.verbose = verbose
    
    def _log(self, message):
        """Print message if verbose mode enabled"""
        if self.verbose:
            timestamp = time.strftime("%H:%M:%S")
            print(f"[{timestamp}] {message}")
    
    def click_and_press(self, key_name="enter"):
        """
        Click terminal and press a key.
        
        Args:
            key_name: Key to press ("enter", "tab", "down", "up", etc.)
        
        Returns:
            True if successful, False if failed
        """
        key_lower = key_name.lower()
        
        if key_lower not in self.KEY_CODES:
            self._log(f"❌ Unknown key: {key_name}")
            return False
        
        key_code = self.KEY_CODES[key_lower]
        
        script = f"""
tell application "System Events"
    click at {{{self.x}, {self.y}}}
    delay 0.3
    key code {key_code}
end tell
"""
        
        try:
            subprocess.run(
                ['osascript', '-e', script],
                capture_output=True,
                timeout=5,
                check=True
            )
            self._log(f"✓ Clicked ({self.x}, {self.y}) and pressed '{key_name}'")
            return True
        except Exception as e:
            self._log(f"❌ Failed: {e}")
            return False
    
    def type_and_enter(self, text):
        """
        Click terminal, type text, and press Enter.
        
        Args:
            text: Text to type (max 100 chars for safety)
        
        Returns:
            True if successful, False if failed
        """
        # Safety check - don't type huge amounts
        if len(text) > 100:
            self._log(f"❌ Text too long ({len(text)} chars, max 100)")
            return False
        
        script = f"""
tell application "System Events"
    click at {{{self.x}, {self.y}}}
    delay 0.2
    keystroke "{text}"
    key code 36
end tell
"""
        
        try:
            subprocess.run(
                ['osascript', '-e', script],
                capture_output=True,
                timeout=5,
                check=True
            )
            self._log(f"✓ Typed '{text}' and pressed Enter")
            return True
        except Exception as e:
            self._log(f"❌ Failed: {e}")
            return False
    
    def click(self):
        """Just click the terminal (no key press)"""
        script = f"""
tell application "System Events"
    click at {{{self.x}, {self.y}}}
end tell
"""
        try:
            subprocess.run(
                ['osascript', '-e', script],
                capture_output=True,
                timeout=5,
                check=True
            )
            self._log(f"✓ Clicked ({self.x}, {self.y})")
            return True
        except Exception as e:
            self._log(f"❌ Failed: {e}")
            return False
    
    def press_key(self, key_name):
        """Press a key (must click first separately)"""
        key_lower = key_name.lower()
        
        if key_lower not in self.KEY_CODES:
            self._log(f"❌ Unknown key: {key_name}")
            return False
        
        key_code = self.KEY_CODES[key_lower]
        
        script = f"""
tell application "System Events"
    key code {key_code}
end tell
"""
        
        try:
            subprocess.run(
                ['osascript', '-e', script],
                capture_output=True,
                timeout=5,
                check=True
            )
            self._log(f"✓ Pressed '{key_name}'")
            return True
        except Exception as e:
            self._log(f"❌ Failed: {e}")
            return False
    
    def monitor_and_click(self, interval=5, duration=300, key="enter"):
        """
        Monitor terminal and click every N seconds.
        
        Args:
            interval: Seconds between clicks (default: 5)
            duration: Total seconds to monitor (default: 300 = 5 minutes)
            key: Key to press ("enter", "tab", etc.)
        
        Example:
            tc = TerminalClicker(x=640, y=400)
            tc.monitor_and_click(interval=5, duration=600)  # Click every 5s for 10 min
        """
        print(f"\n{'='*60}")
        print(f"TERMINAL MONITOR - CLICKING EVERY {interval}s")
        print(f"Duration: {duration}s ({duration//60} minutes)")
        print(f"Position: ({self.x}, {self.y})")
        print(f"Key: {key}")
        print(f"{'='*60}\n")
        print("Press Ctrl+C to stop\n")
        
        start = time.time()
        clicks = 0
        
        try:
            while (time.time() - start) < duration:
                self.click_and_press(key)
                clicks += 1
                
                # Show progress every 10 clicks
                if clicks % 10 == 0:
                    elapsed = int(time.time() - start)
                    remaining = duration - elapsed
                    self._log(f"Progress: {clicks} clicks, {elapsed}s elapsed, {remaining}s remaining")
                
                time.sleep(interval)
        
        except KeyboardInterrupt:
            elapsed = int(time.time() - start)
            self._log(f"\n❌ Stopped after {clicks} clicks in {elapsed}s")
    
    def set_position(self, x, y):
        """Update terminal position"""
        self.x = x
        self.y = y
        self._log(f"Position updated to ({x}, {y})")


def demo():
    """Run a demo of the terminal clicker"""
    print("\n" + "="*60)
    print("TERMINAL CLICKER - DEMO")
    print("="*60 + "\n")
    
    # Create clicker at center of screen
    tc = TerminalClicker(x=640, y=400)
    
    print("Demo actions:")
    print("1. Click and press Enter")
    print("2. Type 'hello' and press Enter")
    print("3. Monitor mode (click every 5s for 30s)\n")
    
    response = input("Run demo? (y/n): ").strip().lower()
    
    if response != 'y':
        print("Demo cancelled")
        return
    
    print("\n--- Demo: Click and Enter ---")
    input("Ready? Press Enter...")
    tc.click_and_press("enter")
    time.sleep(2)
    
    print("\n--- Demo: Type and Enter ---")
    input("Ready? Press Enter...")
    tc.type_and_enter("hello")
    time.sleep(2)
    
    print("\n--- Demo: Monitor Mode (will click every 5s for 30s) ---")
    response = input("Start monitor? (y/n): ").strip().lower()
    if response == 'y':
        tc.monitor_and_click(interval=5, duration=30, key="enter")
    
    print("\n✓ Demo complete!")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "demo":
        demo()
    else:
        print(__doc__)
        print("\nQuick Start:")
        print("  python3 terminal_clicker.py demo          # Run interactive demo")
        print("  python3 terminal_clicker.py --help        # Show this help\n")
        print("Example code:")
        print("""
  from terminal_clicker import TerminalClicker
  
  # Create clicker (center of screen)
  tc = TerminalClicker(x=640, y=400)
  
  # Simple click + Enter
  tc.click_and_press("enter")
  
  # Type text + Enter
  tc.type_and_enter("my_command")
  
  # Monitor mode (click every 5s for 10 minutes)
  tc.monitor_and_click(interval=5, duration=600)
""")
