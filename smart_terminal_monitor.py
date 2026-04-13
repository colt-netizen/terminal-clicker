#!/usr/bin/env python3
"""
Smart Terminal Monitor - Actually intelligent terminal monitoring using vision AI

This is NOT a dumb key presser. This:
1. Takes screenshots
2. Sends to vision AI to understand state
3. Makes intelligent decisions
4. Sends guidance to stuck agents
5. Logs everything

Requires vision API (Claude, OpenAI, etc.)
"""

import subprocess
import time
import json
import re
import sys
import base64
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, Optional


class SmartTerminalMonitor:
    """
    Intelligent terminal monitor that uses vision AI to understand what's happening
    and make smart decisions about how to help a Claude agent progress.
    """
    
    def __init__(self, 
                 terminal_position=(640, 400), 
                 agent_goal="Complete the assigned task",
                 vision_api_key=None,
                 vision_model="gpt-4-vision-preview"):
        """
        Initialize smart monitor.
        
        Args:
            terminal_position: (x, y) screen coordinates
            agent_goal: What the agent is supposed to accomplish
            vision_api_key: API key for vision AI (OpenAI)
            vision_model: Vision model to use ("gpt-4-vision-preview", etc.)
        """
        self.x, self.y = terminal_position
        self.agent_goal = agent_goal
        self.vision_api_key = vision_api_key or self._get_openai_key()
        self.vision_model = vision_model
        self.iteration = 0
        self.stuck_count = 0
        self.log_path = Path.home() / "terminal_monitor.jsonl"
        self.verbose = True
    
    def _get_openai_key(self):
        """Get OpenAI key from environment"""
        import os
        return os.environ.get("OPENAI_API_KEY", "")
    
    def _log(self, message, level="INFO"):
        """Print timestamped log"""
        if self.verbose:
            timestamp = time.strftime("%H:%M:%S")
            print(f"[{timestamp}] [{level}] {message}")
    
    def take_screenshot(self) -> str:
        """Take screenshot of terminal"""
        subprocess.run("screencapture -x /tmp/terminal_monitor.png", shell=True)
        return "/tmp/terminal_monitor.png"
    
    def analyze_with_vision(self, screenshot_path: str) -> Dict[str, Any]:
        """
        Send screenshot to vision AI and get analysis.
        
        Returns dict with:
            - status: RUNNING, PAUSED, ERROR, BLOCKED, COMPLETE, UNKNOWN
            - showing: What's visible
            - is_paused: True if waiting for input
            - recommended_action: What to do next
            - progress: Whether making progress
        """
        
        if not self.vision_api_key:
            self._log("No vision API key, using mock analysis", "WARN")
            return self._mock_analysis()
        
        try:
            return self._call_openai_vision(screenshot_path)
        except Exception as e:
            self._log(f"Vision API error: {e}", "ERROR")
            return self._mock_analysis()
    
    def _call_openai_vision(self, screenshot_path: str) -> Dict[str, Any]:
        """Call OpenAI Vision API"""
        import requests
        
        # Read and encode screenshot
        with open(screenshot_path, "rb") as f:
            image_data = base64.b64encode(f.read()).decode("utf-8")
        
        prompt = f"""Analyze this terminal screenshot where a Claude Code agent is working.

AGENT'S GOAL: {self.agent_goal}

Respond with JSON containing:
{{
    "status": "one of: RUNNING, PAUSED_PROMPT, ERROR, BLOCKED, COMPLETE, UNKNOWN",
    "showing": "last 1-2 lines visible or current prompt",
    "is_paused": true/false,
    "recommended_action": "Press Enter" or "Type [text]" or "Retry" or "Wait" or specific instruction",
    "progress": "Making progress toward goal" or "Stuck/not progressing",
    "details": "Any additional observations"
}}

Be brief and specific."""
        
        response = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {self.vision_api_key}",
                "Content-Type": "application/json"
            },
            json={
                "model": self.vision_model,
                "messages": [{
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/png;base64,{image_data}",
                                "detail": "low"
                            }
                        },
                        {
                            "type": "text",
                            "text": prompt
                        }
                    ]
                }],
                "max_tokens": 300
            },
            timeout=30
        )
        
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        
        # Extract JSON from response
        try:
            # Try to find JSON in response
            json_match = re.search(r'\{.*\}', content, re.DOTALL)
            if json_match:
                return json.loads(json_match.group())
        except:
            pass
        
        # Fallback if JSON parsing fails
        return {
            "status": "UNKNOWN",
            "showing": content[:100],
            "is_paused": False,
            "recommended_action": "Check vision response",
            "progress": "Unable to determine"
        }
    
    def _mock_analysis(self) -> Dict[str, Any]:
        """Mock analysis for testing without API key"""
        return {
            "status": "RUNNING",
            "showing": "Mock terminal (no API key set)",
            "is_paused": False,
            "recommended_action": "Wait, don't interrupt",
            "progress": "Mock mode - set OPENAI_API_KEY to use real vision AI"
        }
    
    def click_and_press_key(self, key_code=36):
        """Click terminal and press key (36=Enter)"""
        script = f"""
tell application "System Events"
    click at {{{self.x}, {self.y}}}
    delay 0.3
    key code {key_code}
end tell
"""
        subprocess.run(['osascript', '-e', script], capture_output=True)
    
    def type_in_terminal(self, text: str):
        """Type text into terminal and press Enter"""
        # Escape quotes
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
    
    def send_agent_guidance(self, guidance: str):
        """Send guidance prompt to agent in terminal"""
        self.type_in_terminal(guidance)
        self._log(f"Sent guidance: {guidance[:50]}...")
    
    def decide_action(self, analysis: Dict) -> str:
        """
        Based on vision analysis, decide what to do.
        This is where the intelligence lives.
        """
        
        status = analysis.get("status", "UNKNOWN")
        recommendation = analysis.get("recommended_action", "")
        is_paused = analysis.get("is_paused", False)
        showing = analysis.get("showing", "")
        
        self._log(f"Status: {status} | Showing: {showing[:40]}...")
        
        # RUNNING - don't interrupt
        if status == "RUNNING":
            self.stuck_count = 0
            self._log("Agent running, not interrupting")
            return "wait"
        
        # PAUSED - agent needs input
        elif status == "PAUSED_PROMPT":
            if "press enter" in recommendation.lower() or "enter" in showing.lower():
                self._log("Agent paused, pressing Enter")
                self.click_and_press_key(36)
                self.stuck_count = 0
                return "pressed_enter"
            
            elif "type" in recommendation.lower():
                # Extract what to type
                match = re.search(r'[Tt]ype\s+(?:the\s+)?["\']?([^"\']+)["\']?', recommendation)
                if match:
                    text = match.group(1)
                    self._log(f"Typing response: {text}")
                    self.type_in_terminal(text)
                    self.stuck_count = 0
                    return "typed_response"
            
            self.stuck_count += 1
            self._log(f"Paused, unclear action (stuck count: {self.stuck_count})")
            return "paused_unclear"
        
        # ERROR - something broke
        elif status == "ERROR":
            self._log(f"ERROR detected: {analysis.get('details', 'Unknown error')}", "ERROR")
            
            if "recoverable" in recommendation.lower() or "retry" in recommendation.lower():
                self._log("Recoverable error, retrying...")
                self.click_and_press_key(36)
                return "retry_after_error"
            else:
                self._log("Non-recoverable error, need escalation", "ERROR")
                return "escalate"
        
        # BLOCKED - agent stuck
        elif status == "BLOCKED":
            self.stuck_count += 1
            self._log(f"Agent BLOCKED (count: {self.stuck_count})", "WARN")
            
            if self.stuck_count >= 3:
                # After 3 checks, send guidance
                guidance = f"You're stuck. Continue working toward: {self.agent_goal}. Next step?"
                self._log("Sending guidance to unstuck agent")
                self.send_agent_guidance(guidance)
                self.stuck_count = 0
                return "sent_guidance"
            
            return "blocked_waiting"
        
        # COMPLETE - done
        elif status == "COMPLETE":
            self._log("TASK COMPLETE!", level="SUCCESS")
            return "complete"
        
        else:
            self._log(f"Unknown status: {status}", "WARN")
            return "unknown"
    
    def log_iteration(self, action: str, analysis: Dict):
        """Log iteration for debugging"""
        event = {
            "timestamp": datetime.now().isoformat(),
            "iteration": self.iteration,
            "action": action,
            "status": analysis.get("status"),
            "recommendation": analysis.get("recommended_action")
        }
        
        with open(self.log_path, "a") as f:
            f.write(json.dumps(event) + "\n")
    
    def run(self, duration=600, check_interval=5):
        """
        Run the smart monitor.
        
        Args:
            duration: How long to monitor (seconds)
            check_interval: How often to check (seconds)
        """
        
        print(f"\n{'='*70}")
        print("SMART TERMINAL MONITOR - VISION AI POWERED")
        print(f"{'='*70}")
        print(f"Goal: {self.agent_goal}")
        print(f"Position: ({self.x}, {self.y})")
        print(f"Duration: {duration}s ({duration//60}m)")
        print(f"Check interval: {check_interval}s")
        print(f"Log: {self.log_path}")
        print(f"{'='*70}\n")
        
        if not self.vision_api_key:
            print("⚠️  No OPENAI_API_KEY set - using mock analysis")
            print("   Set OPENAI_API_KEY environment variable to enable real vision AI\n")
        
        start_time = time.time()
        
        try:
            while (time.time() - start_time) < duration:
                self.iteration += 1
                
                # Screenshot
                screenshot = self.take_screenshot()
                
                # Analyze with vision
                analysis = self.analyze_with_vision(screenshot)
                
                # Decide and act
                action = self.decide_action(analysis)
                
                # Log
                self.log_iteration(action, analysis)
                
                # Handle completion/escalation
                if action == "complete":
                    self._log("Task complete, stopping")
                    break
                
                if action == "escalate":
                    self._log("Need human intervention, stopping", "ERROR")
                    break
                
                # Wait before next check
                elapsed = int(time.time() - start_time)
                remaining = duration - elapsed
                self._log(f"Waiting {check_interval}s (elapsed: {elapsed}s, remaining: {remaining}s)")
                
                time.sleep(check_interval)
        
        except KeyboardInterrupt:
            self._log("Stopped by user")
        
        self._log(f"Monitor complete. Log: {self.log_path}")


if __name__ == "__main__":
    import os
    
    # Get API key
    api_key = os.environ.get("OPENAI_API_KEY")
    
    if not api_key:
        print("Note: OPENAI_API_KEY not set. Running in mock mode.")
        print("To enable real vision analysis:")
        print("  export OPENAI_API_KEY='your-key-here'")
        print()
    
    # Create monitor
    monitor = SmartTerminalMonitor(
        terminal_position=(640, 400),
        agent_goal="Complete your assigned task and report results",
        vision_api_key=api_key
    )
    
    # Run for 10 minutes, check every 5 seconds
    monitor.run(duration=600, check_interval=5)
