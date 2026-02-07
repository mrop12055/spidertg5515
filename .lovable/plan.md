

## Update RUN.bat to Generate Log Files

### What Changes
Update the `run.bat` template in the Setup Guide so the Python runner automatically saves all output (stdout + stderr) to a timestamped log file while still showing output in the terminal.

### Technical Details

**File:** `src/pages/SetupGuide.tsx` (lines 1576-1609)

Replace the current `runBat` constant with a version that:
1. Creates a `logs` folder automatically
2. Generates a timestamped log filename (e.g., `runner_2026-02-07_14-30-00.log`)
3. Uses PowerShell's `Tee-Object` to pipe output to both the console AND the log file
4. Falls back to simple redirect (`>`) if PowerShell is unavailable
5. Shows the log file location on startup so users know where to find it

**Updated run.bat behavior:**
- On each run, a new log file is created in `logs/` folder
- All output (including errors) is captured
- User can still see live output in the terminal
- After a crash, the log file persists for debugging

### Version Bump
The `runnerBuild` version string should also be updated to reflect this change, ensuring users download the latest version with logging enabled.

