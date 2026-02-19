-- Security Hardening Script for Supabase
-- This script enables Row Level Security (RLS) on all tables in the public schema
-- and sets up a strict read-only policy for anonymous users.

-- 1. Enable RLS on all existing tables in the 'public' schema
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.tablename);
    END LOOP;
END $$;

-- 2. Create a read-only policy for 'anon' role on all tables
-- Note: Policies must be created per table. This block iterates and creates them.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        -- Drop existing policy if exists to avoid errors (optional, for idempotency)
        BEGIN
            EXECUTE format('DROP POLICY IF EXISTS "Allow public read-only" ON public.%I;', r.tablename);
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;

        -- Create the policy: Allow SELECT for 'anon' role
        -- This policy allows the 'anon' role (public users) to SELECT all rows.
        EXECUTE format('CREATE POLICY "Allow public read-only" ON public.%I FOR SELECT TO anon USING (true);', r.tablename);

        -- By default, RLS denies all operations that are not explicitly allowed by a policy.
        -- Therefore, INSERT, UPDATE, and DELETE are automatically blocked for 'anon'
        -- unless another policy specifically allows them.
    END LOOP;
END $$;
