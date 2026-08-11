// supabaseClient.js
// One shared connection to Supabase, used by every page (navbar, customizer,
// projects, account). Import it wherever you need it:
//     import { supabase } from "./supabaseClient.js";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://eyxhymlxcotkbjuteqgl.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV5eGh5bWx4Y290a2JqdXRlcWdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0ODAxMTksImV4cCI6MjEwMjA1NjExOX0.js90nX3a9bxCSqBNVWKMQSj9GHK9SWXTiskqijXNhmU";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Helper: is this a REAL signed-up account (not an anonymous guest)?
export async function getAccount() {
  const { data: { session } } = await supabase.auth.getSession();
  const isRealAccount = !!session && session.user.is_anonymous === false;
  return { session, isRealAccount };
}
