#!/usr/bin/env python3
"""
Smart Terminal Monitor Daemon - Background monitoring without interfering

This runs as a background daemon that:
1. Doesn't block your work
2. Pauses when you're actively using the computer
3. Only acts on terminals when they're paused
4. Logs everything for debugging
5. Can be started/stopped without killing your processes
"""

import subprocess
import time
import json
import re
import sys
import base64
import os
import signal
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, Optional
import threading


class BackgroundTerminalMonitor:
    """
    Non-blocking background daemon for terminal monitoring.
    """
    
    def __init__(self, 
                 terminal_position=(640, 400),
                 agent_goal="Complete assigned task",
                 vision_api_key=None,
                 check_interval=5,
                 pause_on_activity=True):
        """
        Initialize background monitor daemon.
        
        Args:
            terminal_position: (x, y) screen coordinates of terminal
            agent_goal: What the agent is trying to accomplish
            vision_api_key: OpenAI API key (or read from env)
            check_interval: How often to check in seconds
            pause_on_activity: Pause monitoring while you're actively using computer
        """
        self.x, self.y = terminal_position
        self.agent_goal = agent_goal
        self.vision_api_key = vision_api_key or os.environ.get("OPENAI_API_KEY", "")
        self.check_interval = check_interval
        self.pause_on_activity = pause_on_activity
        
        self.is_running = False
        self.is_paused = False
        self.iteration = 0
        self.stuck_count = 0
        self.last_activity_time = time.time()
        
        # Logs
        self.log_dir = Path.home() / ".terminal_monitor"
        self.log_dir.mkdir(exist_ok=True)
        self.log_path = self.log_dir / f"monitor_{datetime.now().strftime('%Y%m%d_%H%M%S')}.jsonl"
        self.status_file = self.log_dir / "status.json"
        
        # Thread
        self.monitor_thread = None
        self._shutdown_event = threading.Event()
    
    def _get_mouse_position(self) -> tuple:
        """Get current mouse position"""
        script = """
tell application "System Events"
    return the mouse position
end tell
"""
        try:
            result = subprocess.run(['osascript', '-e', script], 
                                  capture_output=True, text=True, timeout=2)
            if result.returncode == 0:
                x, y = map(int, result.stdout.strip().split(", "))
                return (x, y)
        except:
            pass
        return (0, 0)
    
    def _detect_user_activity(self) -> bool:
        """
        Detect if user is actively using computer.
        Returns True if activity detected in last N seconds.
        """
        if not self.pause_on_activity:
            return False
        
        # Get mouse position
        current_pos = self._get_mouse_position()
        
        # Check if mouse moved significantly
        # (This is approximate - just checks if position changed)
        if current_pos != getattr(self, '_last_mouse_pos', current_pos):
            self._last_mouse_pos = current_pos
            self.last_activity_time = time.time()
            return True
        
        # Check if user was active recently
        time_since_activity = time.time() - self.last_activity_time
        return time_since_activity < 5  # Activity within last 5 seconds
    
    def _log(self, message: str, level="INFO"):
        """Log message to file and optionally console"""
        timestamp = datetime.now().isoformat()
        log_entry = {
            "timestamp": timestamp,
            "level": level,
            "message": message,
            "iteration": self.iteration
        }
        
        # Write to log file
        with open(self.log_path, "a") as f:
            f.write(json.dumps(log_entry) + "\n")
        
        # Print to console
        print(f"[{timestamp}] [{level}] {message}")
    
    def _update_status(self, status: str, details: Dict = None):
        """Update status file (so external tools can check status)"""
        status_data = {
            "timestamp": datetime.now().isoformat(),
            "status": status,
            "iteration": self.iteration,
            "paused": self.is_paused,
            "details": details or {}
        }
        
        with open(self.status_file, "w") as f:
            json.dump(status_data, f)
    
    def take_screenshot(self) -> str:
        """Take screenshot"""
        screenshot_path = self.log_dir / "last_screenshot.png"
        subprocess.run(f"screencapture -x {screenshot_path}", shell=True)
        return str(screenshot_path)
    
    def analyze_with_vision(self, screenshot_path: str) -> Dict[str, Any]:
        """Send to vision AI for analysis"""
        
        if not self.vision_api_key:
            return {
                "status": "RUNNING",
                "showing": "No API key - mock mode",
                "is_paused": False,
                "recommended_action": "Wait"
            }
        
        try:
            with open(screenshot_path, "rb") as f:
                image_data = base64.b64encode(f.read()).decode("utf-8")
            
            import requests
            
            prompt = f"""Quick terminal status check.
Agent goal: {self.agent_goal}

Return JSON:
{{"status": "RUNNING|PAUSED|ERROR|BLOCKED|COMPLETE", "action": "wait|enter|type:text|retry|escalate"}}"""
            
            response = requests.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {self.vision_api_key}"},
                json={
                    "model": "gpt-4-vision-preview",
                    "messages": [{
                        "role": "user",
                        "content": [
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:image/png;base64,{image_data}", "detail": "low"}
                            },
                            {"type": "text", "text": prompt}
                        ]
                    }],
                    "max_tokens": 100
                },
                timeout=15
            )
            
            content = response.json()["choices"][0]["message"]["content"]
            
            # Try to extract JSON
            try:
                json_match = re.search(r'\{.*\}', content, re.DOTALL)
                if json_match:
                    return json.loads(json_match.group())
            except:
                pass
            
            return {"status": "UNKNOWN", "action": "wait"}
        
        except Exception as e:
            self._log(f"Vision API error: {e}", "WARN")
            return {"status": "UNKNOWN", "action": "wait"}
    
    def click_and_press(self, key_code=36):
        """Click terminal and press key"""
        script = f"""
tell application "System Events"
    click at {{{self.x}, {self.y}}}
    delay 0.3
    key code {key_code}
end tell
"""
        subprocess.run(['osascript', '-e', script], capture_output=True)
    
    def type_and_enter(self, text: str):
        """Type text into terminal"""
        text = text.replace('"', '\\"')
        script = f"""
tell application "System Events"
    click at {{{self.x}, {self.y}}}
    delay 0.2
    keystroke "{text}"
    key code 36
end tell
"""
        subprocess.run(['osascript', '-e', script], capture_output=True)
    
    def _monitor_loop(self):
        """Main monitoring loop (runs in background thread)"""
        
        self._log("Background monitor started")
        self._update_status("running")
        
        while not self._shutdown_event.is_set():
            try:
                self.iteration += 1
                
                # Check if user is active
                if self._detect_user_activity():
                    if not self.is_paused:
                        self._log("User activity detected, pausing monitor")
                        self.is_paused = True
                        self._update_status("paused_user_activity")
                    time.sleep(1)
                    continue
                else:
                    if self.is_paused:
                        self._log("No user activity, resuming monitor")
                        self.is_paused = False
                
                # Take screenshot
                screenshot = self.take_screenshot()
                
                # Analyze
                analysis = self.analyze_with_vision(screenshot)
                status = analysis.get("status", "UNKNOWN")
                action = analysis.get("action", "wait")
                
                self._log(f"Status: {status} | Action: {action}")
                self._update_status(status, {"action": action})
                
                # Act
                if action == "enter":
                    self._log("Pressing Enter")
                    self.click_and_press(36)
                    self.stuck_count = 0
                
                elif action.startswith("type:"):
                    text = action[5:]
                    self._log(f"Typing: {text}")
                    self.type_and_enter(text)
                    self.stuck_count = 0
                
                elif action == "retry":
                    self._log("Retrying")
                    self.click_and_press(36)
                
                elif action == "escalate":
                    self._log("ESCALATE - need human intervention", "ERROR")
                    self._update_status("escalate_needed")
                
                elif action == "wait":
                    pass
                
                if status == "COMPLETE":
                    self._log("Task complete!")
                    self._update_status("complete")
                    break
                
                # Wait before next check
                time.sleep(self.check_interval)
            
            except Exception as e:
                self._log(f"Error in monitor loop: {e}", "ERROR")
                time.sleep(self.check_interval)
        
        self._log("Monitor stopped")
        self._update_status("stopped")
    
    def start(self):
        """Start the background monitor"""
        if self.is_running:
            self._log("Monitor already running", "WARN")
            return
        
        self.is_running = True
        self._shutdown_event.clear()
        
        # Start monitoring in background thread
        self.monitor_thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self.monitor_thread.start()
        
        self._log(f"Background monitor started (PID will be daemon)")
        self._log(f"Status file: {self.status_file}")
        self._log(f"Logs: {self.log_path}")
    
    def stop(self):
        """Stop the background monitor gracefully"""
        if not self.is_running:
            return
        
        self._log("Stopping monitor...")
        self._shutdown_event.set()
        
        if self.monitor_thread:
            self.monitor_thread.join(timeout=5)
        
        self.is_running = False
        self._log("Monitor stopped")
    
    def check_status(self) -> Dict:
        """Check current status without interfering"""
        if self.status_file.exists():
            with open(self.status_file) as f:
                return json.load(f)
        return {"status": "unknown"}


# Global instance for signal handling
_monitor = None

def _handle_shutdown(signum, frame):
    """Handle Ctrl+C gracefully"""
    print("\nShutting down monitor...")
    if _monitor:
        _monitor.stop()
    sys.exit(0)


def start_daemon(terminal_pos=(640, 400), goal="Complete task"):
    """Start monitor in background"""
    global _monitor
    
    api_key = os.environ.get("OPENAI_API_KEY", "")
    
    _monitor = BackgroundTerminalMonitor(
        terminal_position=terminal_pos,
        agent_goal=goal,
        vision_api_key=api_key,
        check_interval=5,
        pause_on_activity=True
    )
    
    signal.signal(signal.SIGINT, _handle_shutdown)
    
    _monitor.start()
    
    # Keep running
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        _handle_shutdown(None, None)


def check_daemon_status() -> Dict:
    """Check if daemon is running and its status"""
    status_file = Path.home() / ".terminal_monitor" / "status.json"
    
    if status_file.exists():
        with open(status_file) as f:
            return json.load(f)
    
    return {"status": "not_running"}


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Background terminal monitor daemon")
    parser.add_argument("--x", type=int, default=640, help="Terminal X position")
    parser.add_argument("--y", type=int, default=400, help="Terminal Y position")
    parser.add_argument("--goal", default="Complete the task", help="Agent's goal")
    parser.add_argument("--status", action="store_true", help="Check daemon status")
    
    args = parser.parse_args()
    
    if args.status:
        status = check_daemon_status()
        print(json.dumps(status, indent=2))
    else:
        print(f"Starting background terminal monitor daemon...")
        print(f"Terminal position: ({args.x}, {args.y})")
        print(f"Goal: {args.goal}")
        print(f"Pauses when you're actively using the computer")
        print(f"Logs to: ~/.terminal_monitor/")
        print(f"Press Ctrl+C to stop\n")
        
        start_daemon(terminal_pos=(args.x, args.y), goal=args.goal)
