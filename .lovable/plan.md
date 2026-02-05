
## Unrestrict All Restricted Accounts

This will reset all 21 currently restricted accounts back to `active` status so they can resume sending messages.

### What Will Be Updated

| Field | Current Value | New Value |
|-------|---------------|-----------|
| `status` | `restricted` | `active` |
| `restricted_until` | Various timestamps | `NULL` |
| `ban_reason` | PeerFlood / Recipient not found | `NULL` |
| `auto_disabled` | false | `false` (unchanged) |

### Accounts to be Unrestricted (21 total)

All accounts currently showing `status = 'restricted'` including:
- +919342782870, +917994811752, +916354629010
- +918433296098, +919767181158, +918817611276
- And 15 more...

---

### Technical Details

**Database Migration:**
```sql
UPDATE telegram_accounts
SET 
  status = 'active',
  restricted_until = NULL,
  ban_reason = NULL
WHERE status = 'restricted';
```

This single UPDATE statement will:
1. Change status from `restricted` to `active`
2. Clear the `restricted_until` timestamp
3. Clear the `ban_reason` field

**Note:** These accounts were restricted due to Telegram's PeerFlood rate limiting. After unrestricting, consider reducing campaign sending speed to avoid triggering restrictions again.
