UPDATE messages 
SET status = 'pending' 
WHERE status = 'sending' 
AND created_at < NOW() - INTERVAL '1 minute'