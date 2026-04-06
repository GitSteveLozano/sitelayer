-- Migration: Time Tracking + Crew Scheduling
-- Run in Supabase SQL Editor

-- 1. Workers table (crew roster)
CREATE TABLE IF NOT EXISTS workers (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  role text,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  UNIQUE(company_id, name)
);

-- 2. Crew schedules (weekly assignments)
CREATE TABLE IF NOT EXISTS crew_schedules (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  work_date date NOT NULL,
  scheduled_workers uuid[] DEFAULT '{}',
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  UNIQUE(company_id, work_date)
);

-- 3. Labor entries (time tracking)
ALTER TABLE labor_entries ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE labor_entries ADD COLUMN IF NOT EXISTS worker_id uuid REFERENCES workers(id) ON DELETE SET NULL;
ALTER TABLE labor_entries ADD COLUMN IF NOT EXISTS work_date date NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE labor_entries ADD COLUMN IF NOT EXISTS service_item text;
ALTER TABLE labor_entries ADD COLUMN IF NOT EXISTS status text DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed'));

-- Indexes
CREATE INDEX IF NOT EXISTS idx_labor_workers ON labor_entries(worker_id);
CREATE INDEX IF NOT EXISTS idx_labor_dates ON labor_entries(work_date);
CREATE INDEX IF NOT EXISTS idx_labor_project ON labor_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_schedules_date ON crew_schedules(work_date);

-- Enable RLS
ALTER TABLE workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE crew_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE labor_entries ENABLE ROW LEVEL SECURITY;

-- Policies: users see their company's data
CREATE POLICY "Users see workers" ON workers FOR SELECT USING (company_id IN (
  SELECT company_id FROM company_users WHERE user_id = auth.uid()
));
CREATE POLICY "Users mod workers" ON workers FOR ALL USING (company_id IN (
  SELECT company_id FROM company_users WHERE user_id = auth.uid()
));

CREATE POLICY "Users see schedules" ON crew_schedules FOR SELECT USING (company_id IN (
  SELECT company_id FROM company_users WHERE user_id = auth.uid()
));
CREATE POLICY "Users mod schedules" ON crew_schedules FOR ALL USING (company_id IN (
  SELECT company_id FROM company_users WHERE user_id = auth.uid()
));

CREATE POLICY "Users see entries" ON labor_entries FOR SELECT USING (company_id IN (
  SELECT company_id FROM company_users WHERE user_id = auth.uid()
));
CREATE POLICY "Users mod entries" ON labor_entries FOR ALL USING (company_id IN (
  SELECT company_id FROM company_users WHERE user_id = auth.uid()
));
