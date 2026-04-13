#!/usr/bin/env python3
"""
Terminal Monitor Launcher - Start/stop the background daemon cleanly

This handles:
1. Starting the daemon as a background process (not blocking your terminal)
2. Stopping the daemon when you want
3. Checking daemon status
4. Viewing logs
5. Automatic restart on crash
"""

import subprocess
import json
import time
import sys
from pathlib import Path
from datetime import datetime


class DaemonLauncher:
    """Launch and manage the terminal monitor daemon"""
    
    def __init__(self, terminal_x=640, terminal_y=400, goal="Complete task"):
        self.terminal_x = terminal_x
        self.terminal_y = terminal_y
        self.goal = goal
        
        self.daemon_dir = Path.home() / ".terminal_monitor"
        self.daemon_dir.mkdir(exist_ok=True)
        
        self.pid_file = self.daemon_dir / "daemon.pid"
        self.status_file = self.daemon_dir / "status.json"
        self.script_path = Path(__file__).parent / "terminal_monitor_daemon.py"
    
    def start(self):
        """Start daemon in background (non-blocking)"""
        
        if self.is_running():
            print("❌ Daemon already running")
            return False
        
        # Start in background using nohup
        cmd = f"""
nohup python3 {self.script_path} \
  --x {self.terminal_x} \
  --y {self.terminal_y} \
  --goal "{self.goal}" \
  > {self.daemon_dir}/daemon.log 2>&1 &
echo $! > {self.pid_file}
"""
        
        try:
            subprocess.run(cmd, shell=True, check=True)
            time.sleep(1)
            
            if self.is_running():
                pid = self._get_pid()
                print(f"✅ Daemon started (PID: {pid})")
                print(f"   Terminal position: ({self.terminal_x}, {self.terminal_y})")
                print(f"   Goal: {self.goal}")
                print(f"   Logs: {self.daemon_dir}/daemon.log")
                print(f"   Status: {self.status_file}")
                return True
            else:
                print("❌ Failed to start daemon")
                return False
        
        except Exception as e:
            print(f"❌ Error starting daemon: {e}")
            return False
    
    def stop(self):
        """Stop daemon"""
        
        if not self.is_running():
            print("❌ Daemon not running")
            return False
        
        try:
            pid = self._get_pid()
            subprocess.run(f"kill {pid}", shell=True, check=True)
            time.sleep(1)
            
            if not self.is_running():
                print(f"✅ Daemon stopped (was PID: {pid})")
                self.pid_file.unlink(missing_ok=True)
                return True
            else:
                print("❌ Failed to stop daemon")
                return False
        
        except Exception as e:
            print(f"❌ Error stopping daemon: {e}")
            return False
    
    def is_running(self) -> bool:
        """Check if daemon is running"""
        
        if not self.pid_file.exists():
            return False
        
        try:
            pid = int(self.pid_file.read_text().strip())
            # Check if process exists
            subprocess.run(f"kill -0 {pid}", shell=True, check=True, 
                         capture_output=True)
            return True
        except:
            return False
    
    def _get_pid(self) -> int:
        """Get daemon PID"""
        if self.pid_file.exists():
            return int(self.pid_file.read_text().strip())
        return None
    
    def status(self):
        """Show daemon status"""
        
        if not self.is_running():
            print("❌ Daemon not running")
            return
        
        if self.status_file.exists():
            with open(self.status_file) as f:
                status = json.load(f)
            
            print("✅ Daemon running")
            print(f"   Status: {status.get('status', 'unknown')}")
            print(f"   Iteration: {status.get('iteration', 0)}")
            print(f"   Last update: {status.get('timestamp', 'N/A')}")
        else:
            print("✅ Daemon running (no status file yet)")
    
    def logs(self, tail=50):
        """Show latest logs"""
        
        log_file = self.daemon_dir / "daemon.log"
        
        if not log_file.exists():
            print("No logs yet")
            return
        
        # Show last N lines
        try:
            result = subprocess.run(f"tail -n {tail} {log_file}", 
                                  shell=True, capture_output=True, text=True)
            print(result.stdout)
        except Exception as e:
            print(f"Error reading logs: {e}")
    
    def restart(self):
        """Restart daemon"""
        self.stop()
        time.sleep(1)
        self.start()


def main():
    """CLI interface"""
    
    import argparse
    
    parser = argparse.ArgumentParser(description="Terminal Monitor Daemon Launcher")
    parser.add_argument("command", nargs="?", default="status",
                       choices=["start", "stop", "restart", "status", "logs"])
    parser.add_argument("--x", type=int, default=640, help="Terminal X position")
    parser.add_argument("--y", type=int, default=400, help="Terminal Y position")
    parser.add_argument("--goal", default="Complete your task",
                       help="Agent's goal")
    parser.add_argument("--tail", type=int, default=50, help="Log lines to show")
    
    args = parser.parse_args()
    
    launcher = DaemonLauncher(terminal_x=args.x, terminal_y=args.y, goal=args.goal)
    
    if args.command == "start":
        launcher.start()
    elif args.command == "stop":
        launcher.stop()
    elif args.command == "restart":
        launcher.restart()
    elif args.command == "status":
        launcher.status()
    elif args.command == "logs":
        launcher.logs(tail=args.tail)


if __name__ == "__main__":
    main()
