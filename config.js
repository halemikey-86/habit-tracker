// Fill these in from your Supabase project:
// Project Settings -> API -> Project URL / Project API keys -> anon public
window.HQ_CONFIG = {
  SUPABASE_URL: "https://uxaktbbddjjbgldvomga.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_v-3sLkMmkfl1iQiGw3eqGw_5k1Jd5EJ"
};

function isConfigPlaceholder(){
  const c = window.HQ_CONFIG;
  return !c
    || !c.SUPABASE_URL
    || !c.SUPABASE_ANON_KEY
    || c.SUPABASE_URL.includes('YOUR-PROJECT-REF')
    || c.SUPABASE_ANON_KEY.includes('YOUR-ANON');
}
