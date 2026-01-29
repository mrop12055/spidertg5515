

# Delete Consolidated Edge Functions

## Overview

Now that we've created the unified `runner-tasks` function and updated the Python runner to use the new endpoints, we can safely delete the 4 old edge functions that have been consolidated.

## Functions to Delete

| Old Function | New Location |
|-------------|--------------|
| `get-batch-tasks/` | `runner-tasks/get` |
| `get-next-task/` | `runner-tasks/get` |
| `report-task-result/` | `runner-tasks/report` |
| `report-batch-results/` | `runner-tasks/report` |

## Implementation Steps

1. **Delete the old function directories:**
   - `supabase/functions/get-batch-tasks/`
   - `supabase/functions/get-next-task/`
   - `supabase/functions/report-task-result/`
   - `supabase/functions/report-batch-results/`

2. **Remove deployed functions from backend:**
   - Use the delete edge functions tool to remove them from the deployed environment

## Note

The Python runner has already been updated to use the new endpoints (`/runner-tasks/get` and `/runner-tasks/report`), so deleting these old functions will not break anything.

After this cleanup, we'll have reduced from 23 functions down to 19, with the remaining consolidation (warmup functions, utility functions, etc.) available for future cleanup phases.

