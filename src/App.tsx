// src/App.tsx
import React, { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";
import Planificador from "./Planificador"; // <- tu componente con todo

export default function App() {
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      setUserId(data.session?.user?.id ?? null);
      setLoading(false);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, sess) => {
      setUserId(sess?.user?.id ?? null);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  async function sendMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!email) return setMsg("Escribe un correo");
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    setMsg(error ? error.message : "Te he enviado un enlace de login a tu correo.");
  }

  if (loading) return <div style={{ padding: 24 }}>Cargando…</div>;

  // Si NO hay sesión, muestro el login simple
  if (!userId) {
    return (
      <div style={{ maxWidth: 480, margin: "60px auto" }}>
        <h2>Iniciar sesión</h2>
        <form onSubmit={sendMagicLink}>
          <input
            type="email"
            placeholder="tu@correo.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ width: "100%", padding: 10, marginBottom: 10 }}
          />
          <button type="submit">Enviarme enlace mágico</button>
        </form>
        {msg && <p style={{ color: "crimson" }}>{msg}</p>}
      </div>
    );
  }

  // Si HAY sesión, renderizo tu Planificador
  return <Planificador />;
}

