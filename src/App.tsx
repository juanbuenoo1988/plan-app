import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";
import Planificador from "./Planificador"; // <- tu programa

function EmailLogin() {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const sendMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setSending(true);
    setMsg(null);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    setSending(false);
    setMsg(error ? "Error: " + error.message : "Te enviamos un enlace. Revisa bandeja y spam.");
  };

  return (
    <div style={{ width: "100%", maxWidth: 440, margin: "4rem auto", color: "white" }}>
      <h2 style={{ textAlign: "center", marginBottom: 12 }}>Inicia sesión</h2>
      <form onSubmit={sendMagicLink} style={{ display: "grid", gap: 8 }}>
        <input
          type="email"
          required
          placeholder="tu-email@empresa.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ padding: 10, borderRadius: 8, border: "1px solid #444", background: "#111", color: "white" }}
        />
        <button type="submit" disabled={sending}
          style={{ background: "white", color: "black", padding: 10, borderRadius: 8, border: "none", cursor: "pointer" }}>
          {sending ? "Enviando..." : "Enviar enlace mágico"}
        </button>
      </form>
      {msg && <p style={{ marginTop: 8 }}>{msg}</p>}
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) { setSession(data.session); setLoading(false); }
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      if (!cancelled) setSession(s);
    });
    return () => { cancelled = true; subscription.unsubscribe(); };
  }, []);

  if (loading) return <div style={{ padding: 24, color: "white" }}>Cargando…</div>;
  if (!session) return <EmailLogin />;

  // Si hay sesión iniciada, mostramos TU programa:
  return <Planificador />;
}
