-- Create warmup_pairs table for 1-to-1 pairings
CREATE TABLE public.warmup_pairs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_a_id UUID NOT NULL REFERENCES public.telegram_accounts(id) ON DELETE CASCADE,
  account_b_id UUID NOT NULL REFERENCES public.telegram_accounts(id) ON DELETE CASCADE,
  session_id UUID NOT NULL,
  messages_exchanged INTEGER DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_a_id, session_id),
  UNIQUE(account_b_id, session_id)
);

-- Create warmup_messages table for scheduled messages
CREATE TABLE public.warmup_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pair_id UUID NOT NULL REFERENCES public.warmup_pairs(id) ON DELETE CASCADE,
  sender_account_id UUID NOT NULL REFERENCES public.telegram_accounts(id),
  receiver_account_id UUID NOT NULL REFERENCES public.telegram_accounts(id),
  message_content TEXT NOT NULL,
  message_type TEXT DEFAULT 'text',
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  status TEXT DEFAULT 'pending',
  reply_delay_seconds INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create warmup_message_templates table
CREATE TABLE public.warmup_message_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_order INTEGER NOT NULL,
  sender_position TEXT NOT NULL,
  message_text TEXT NOT NULL,
  is_question BOOLEAN DEFAULT false,
  category TEXT DEFAULT 'casual',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create warmup_sessions table to track warmup runs
CREATE TABLE public.warmup_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT DEFAULT 'active',
  total_pairs INTEGER DEFAULT 0,
  messages_per_pair_min INTEGER DEFAULT 5,
  messages_per_pair_max INTEGER DEFAULT 10,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  stopped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.warmup_pairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warmup_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warmup_message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warmup_sessions ENABLE ROW LEVEL SECURITY;

-- Create RLS policies
CREATE POLICY "Allow all operations for warmup_pairs" ON public.warmup_pairs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations for warmup_messages" ON public.warmup_messages FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations for warmup_message_templates" ON public.warmup_message_templates FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations for warmup_sessions" ON public.warmup_sessions FOR ALL USING (true) WITH CHECK (true);

-- Create indexes for performance
CREATE INDEX idx_warmup_messages_status ON public.warmup_messages(status);
CREATE INDEX idx_warmup_messages_scheduled_at ON public.warmup_messages(scheduled_at);
CREATE INDEX idx_warmup_pairs_session_id ON public.warmup_pairs(session_id);

-- Seed message templates with realistic conversations
INSERT INTO public.warmup_message_templates (sequence_order, sender_position, message_text, is_question, category) VALUES
-- Conversation Flow 1: Casual greeting
(1, 'A', 'Hey! 👋', false, 'greeting'),
(2, 'B', 'Hi! How are you?', true, 'greeting'),
(3, 'A', 'I''m good! What about you?', true, 'reply'),
(4, 'B', 'Great! Just chilling', false, 'reply'),
(5, 'A', 'Nice! Any plans for today?', true, 'question'),
(6, 'B', 'Not much, maybe watch some movies', false, 'reply'),
(7, 'A', 'Sounds fun! 🎬', false, 'reply'),
(8, 'B', 'Yeah! Talk later?', true, 'closing'),
(9, 'A', 'Sure! Take care', false, 'closing'),
(10, 'B', 'You too! 👋', false, 'closing'),
-- Conversation Flow 2: Morning check-in
(11, 'A', 'Good morning! ☀️', false, 'greeting'),
(12, 'B', 'Morning! How did you sleep?', true, 'greeting'),
(13, 'A', 'Pretty well actually, you?', true, 'reply'),
(14, 'B', 'Same here! Ready for the day', false, 'reply'),
(15, 'A', 'That''s good to hear!', false, 'reply'),
(16, 'B', 'What''s on your agenda today?', true, 'question'),
(17, 'A', 'Just some work stuff, nothing special', false, 'reply'),
(18, 'B', 'Same lol, the usual grind', false, 'reply'),
(19, 'A', 'Haha yeah, catch you later!', false, 'closing'),
(20, 'B', 'Later! 😊', false, 'closing'),
-- Conversation Flow 3: Evening chat
(21, 'A', 'Hey, what''s up?', true, 'greeting'),
(22, 'B', 'Not much, just relaxing. You?', true, 'reply'),
(23, 'A', 'Same! Tired from work', false, 'reply'),
(24, 'B', 'I feel that 😅', false, 'reply'),
(25, 'A', 'Weekend can''t come soon enough', false, 'casual'),
(26, 'B', 'Tell me about it!', false, 'reply'),
(27, 'A', 'Any weekend plans?', true, 'question'),
(28, 'B', 'Maybe meet some friends, wbu?', true, 'reply'),
(29, 'A', 'Sounds nice! I might just rest', false, 'reply'),
(30, 'B', 'That''s important too! Enjoy 🙌', false, 'closing'),
-- Conversation Flow 4: Quick check
(31, 'A', 'Hey there!', false, 'greeting'),
(32, 'B', 'Hey! Long time!', false, 'greeting'),
(33, 'A', 'I know right! How have you been?', true, 'question'),
(34, 'B', 'Pretty good! Busy with stuff', false, 'reply'),
(35, 'A', 'Same here, life gets crazy', false, 'reply'),
(36, 'B', 'True that! We should catch up sometime', false, 'casual'),
(37, 'A', 'Definitely! Let''s plan something', false, 'reply'),
(38, 'B', 'Sounds good! 👍', false, 'closing'),
(39, 'A', 'Cool, talk soon!', false, 'closing'),
(40, 'B', 'For sure! Bye!', false, 'closing'),
-- Conversation Flow 5: Random chat
(41, 'A', 'Yo!', false, 'greeting'),
(42, 'B', 'Yo! What''s good?', true, 'greeting'),
(43, 'A', 'Nothing much, bored lol', false, 'reply'),
(44, 'B', 'Haha same honestly', false, 'reply'),
(45, 'A', 'Watched anything good lately?', true, 'question'),
(46, 'B', 'Yeah actually, been watching this new series', false, 'reply'),
(47, 'A', 'Oh nice, what is it?', true, 'question'),
(48, 'B', 'I''ll send you the link later!', false, 'reply'),
(49, 'A', 'Sweet, thanks! 🙏', false, 'reply'),
(50, 'B', 'No problem! Enjoy!', false, 'closing');