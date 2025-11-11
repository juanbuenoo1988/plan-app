// src/lib/supabase.ts
import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL!,
  import.meta.env.VITE_SUPABASE_ANON_KEY!,
  {
    auth: {
      persistSession: true,         // guarda la sesión en localStorage
      autoRefreshToken: true,       // refresca el token automáticamente
      detectSessionInUrl: true,     // necesario para los enlaces mágicos (login por email)
    },
    global: {
      fetch: (url, opts) => fetch(url, { ...opts, cache: "no-store" }), // evita respuestas cacheadas
    },
  }
);
