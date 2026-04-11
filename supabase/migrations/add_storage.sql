-- Create storage bucket for blueprints
INSERT INTO storage.buckets (id, name, public)
VALUES ('blueprints', 'blueprints', false)
ON CONFLICT DO NOTHING;

-- RLS: company members can upload/view their own blueprints
CREATE POLICY "blueprint_upload" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'blueprints'
    AND auth.uid() IS NOT NULL
  );

CREATE POLICY "blueprint_select" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'blueprints'
    AND auth.uid() IS NOT NULL
  );

CREATE POLICY "blueprint_update" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'blueprints'
    AND auth.uid() IS NOT NULL
  );

CREATE POLICY "blueprint_delete" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'blueprints'
    AND auth.uid() IS NOT NULL
  );

-- Add blueprint_url to projects table
ALTER TABLE projects ADD COLUMN IF NOT EXISTS blueprint_url text;
