-- Add updated_at column to account_check_tasks to track when status changes
ALTER TABLE public.account_check_tasks 
ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Create trigger to auto-update the timestamp
CREATE OR REPLACE FUNCTION public.update_account_check_tasks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS update_account_check_tasks_updated_at ON public.account_check_tasks;
CREATE TRIGGER update_account_check_tasks_updated_at
  BEFORE UPDATE ON public.account_check_tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.update_account_check_tasks_updated_at();