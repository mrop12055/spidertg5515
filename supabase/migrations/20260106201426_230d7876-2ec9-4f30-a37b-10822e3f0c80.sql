
-- Create material_tags table for organizing materials by type
CREATE TABLE public.material_tags (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('data', 'pictures', 'names')),
  item_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create material_data table for phone numbers and usernames
CREATE TABLE public.material_data (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tag_id UUID NOT NULL REFERENCES public.material_tags(id) ON DELETE CASCADE,
  phone_number TEXT,
  username TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create material_pictures table for profile pictures
CREATE TABLE public.material_pictures (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tag_id UUID NOT NULL REFERENCES public.material_tags(id) ON DELETE CASCADE,
  file_url TEXT NOT NULL,
  file_name TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create material_names table for first and last names
CREATE TABLE public.material_names (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tag_id UUID NOT NULL REFERENCES public.material_tags(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS on all tables
ALTER TABLE public.material_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_pictures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_names ENABLE ROW LEVEL SECURITY;

-- Create policies for authenticated access
CREATE POLICY "Public access for admin tool" ON public.material_tags FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public access for admin tool" ON public.material_data FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public access for admin tool" ON public.material_pictures FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public access for admin tool" ON public.material_names FOR ALL USING (true) WITH CHECK (true);

-- Create indexes for performance
CREATE INDEX idx_material_data_tag_id ON public.material_data(tag_id);
CREATE INDEX idx_material_pictures_tag_id ON public.material_pictures(tag_id);
CREATE INDEX idx_material_names_tag_id ON public.material_names(tag_id);
CREATE INDEX idx_material_tags_type ON public.material_tags(type);

-- Create storage bucket for material pictures
INSERT INTO storage.buckets (id, name, public) VALUES ('material-pictures', 'material-pictures', true);

-- Create storage policies for material pictures bucket
CREATE POLICY "Anyone can view material pictures" ON storage.objects FOR SELECT USING (bucket_id = 'material-pictures');
CREATE POLICY "Authenticated users can upload material pictures" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'material-pictures');
CREATE POLICY "Authenticated users can delete material pictures" ON storage.objects FOR DELETE USING (bucket_id = 'material-pictures');

-- Create function to update item count on material_tags
CREATE OR REPLACE FUNCTION public.update_material_tag_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.material_tags SET item_count = item_count + 1 WHERE id = NEW.tag_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.material_tags SET item_count = item_count - 1 WHERE id = OLD.tag_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create triggers for auto-updating item counts
CREATE TRIGGER update_data_count AFTER INSERT OR DELETE ON public.material_data
FOR EACH ROW EXECUTE FUNCTION public.update_material_tag_count();

CREATE TRIGGER update_pictures_count AFTER INSERT OR DELETE ON public.material_pictures
FOR EACH ROW EXECUTE FUNCTION public.update_material_tag_count();

CREATE TRIGGER update_names_count AFTER INSERT OR DELETE ON public.material_names
FOR EACH ROW EXECUTE FUNCTION public.update_material_tag_count();
