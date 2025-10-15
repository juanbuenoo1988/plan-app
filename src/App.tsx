import { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";

type Item = {
  id: string;
  title: string;
  start_at: string;
  end_at: string;
  status: "planned" | "in_progress" | "done";
  notes: string | null;
  updated_at: string;
};
type Role = "viewer" | "editor" | "admin";

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
  return <PlanningScreen userId={session.user.id} email={session.user.email} />;
}

function PlanningScreen({ userId, email }: { userId: string; email: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [role, setRole] = useState<Role>("viewer");
  const canEdit = role !== "viewer";

  useEffect(() => {
    let mounted = true;

    const loadItems = async () => {
      const { data, error } = await supabase.from("planning_items").select("*").order("start_at", { ascending: true });
      if (!mounted) return;
      if (error) console.error(error);
      setItems((data ?? []) as Item[]);
    };

    const loadRole = async () => {
      const { data, error } = await supabase.from("profiles").select("role").eq("id", userId).single();
      if (!mounted) return;
      if (error) console.error(error);
      if (data?.role) setRole(data.role as Role);
    };

    loadItems();
    loadRole();

    const channel = supabase
      .channel("realtime:planning_items")
      .on("postgres_changes", { event: "*", schema: "public", table: "planning_items" }, () => loadItems())
      .subscribe();

    return () => { mounted = false; supabase.removeChannel(channel); };
  }, [userId]);

  return (
    <div style={{ padding: 24, maxWidth: 1000, margin: "0 auto", color: "white" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700 }}>Planificación</h1>
        <div style={{ fontSize: 14, opacity: 0.8 }}>
          {email} • rol: <b>{role}</b>{" "}
          <button onClick={() => supabase.auth.signOut()}
            style={{ marginLeft: 12, padding: "6px 10px", borderRadius: 8, border: "1px solid #555", background: "#111", color: "white" }}>
            Cerrar sesión
          </button>
        </div>
      </div>
      <ItemList items={items} canEdit={canEdit} />
    </div>
  );
}

function ItemList({ items, canEdit }: { items: Item[]; canEdit: boolean }) {
  const byDay = useMemo(() => {
    const m: Record<string, Item[]> = {};
    items.forEach(i => {
      const key = new Date(i.start_at).toDateString();
      (m[key] ||= []).push(i);
    });
    return m;
  }, [items]);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {Object.entries(byDay).map(([day, group]) => (
        <div key={day} style={{ border: "1px solid #333", borderRadius: 12, padding: 12 }}>
          <h2 style={{ fontWeight: 600, marginBottom: 8 }}>{day}</h2>
          <ul style={{ display: "grid", gap: 8 }}>
            {group.map(it => (
              <li key={it.id} style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center",
                  border: "1px solid #444", borderRadius: 8, padding: 8 }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{it.title}</div>
                  <div style={{ fontSize: 14, opacity: 0.8 }}>
                    {new Date(it.start_at).toLocaleString()} → {new Date(it.end_at).toLocaleString()} • {it.status}
                  </div>
                  {it.notes && <div style={{ fontSize: 14, marginTop: 4 }}>{it.notes}</div>}
                </div>
                {canEdit && <EditButtons item={it} />}
              </li>
            ))}
          </ul>
          {canEdit && <NewItemForm />}
        </div>
      ))}
      {Object.keys(byDay).length === 0 && (
        <div style={{ border: "1px solid #333", borderRadius: 12, padding: 12 }}>
          <p style={{ marginBottom: 8, opacity: 0.8 }}>No hay elementos todavía.</p>
          {canEdit && <NewItemForm />}
        </div>
      )}
    </div>
  );
}

function EditButtons({ item }: { item: Item }) {
  const onAdvance = async () => {
    const next = item.status === "planned" ? "in_progress" : item.status === "in_progress" ? "done" : "planned";
    const { error } = await supabase.from("planning_items").update({ status: next }).eq("id", item.id);
    if (error) alert("Error al actualizar: " + error.message);
  };
  const onDelete = async () => {
    if (!confirm("¿Borrar este elemento?")) return;
    const { error } = await supabase.from("planning_items").delete().eq("id", item.id);
    if (error) alert("Error al borrar: " + error.message);
  };
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <button onClick={onAdvance}
        style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #555", background: "#111", color: "white" }}>
        Cambiar estado
      </button>
      <button onClick={onDelete}
        style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #a44", background: "#311", color: "white" }}>
        Borrar
      </button>
    </div>
  );
}

function NewItemForm() {
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [notes, setNotes] = useState("");

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !start || !end) return alert("Completa título, inicio y fin");
    const { error } = await supabase.from("planning_items").insert({
      title,
      start_at: start,
      end_at: end,
      notes: notes || null,
    });
    if (error) alert("Error al crear: " + error.message);
    else { setTitle(""); setStart(""); setEnd(""); setNotes(""); }
  };

  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: 8, marginTop: 10 }}>
      <input placeholder="Título" value={title} onChange={e=>setTitle(e.target.value)}
             style={{ padding: 8, borderRadius: 8, border: "1px solid #444", background: "#111", color: "white" }}/>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <input type="datetime-local" value={start} onChange={e=>setStart(e.target.value)}
               style={{ padding: 8, borderRadius: 8, border: "1px solid #444", background: "#111", color: "white" }}/>
        <input type="datetime-local" value={end} onChange={e=>setEnd(e.target.value)}
               style={{ padding: 8, borderRadius: 8, border: "1px solid #444", background: "#111", color: "white" }}/>
      </div>
      <textarea placeholder="Notas (opcional)" value={notes} onChange={e=>setNotes(e.target.value)}
                style={{ padding: 8, borderRadius: 8, border: "1px solid #444", background: "#111", color: "white", minHeight: 70 }}/>
      <button style={{ background: "white", color: "black", padding: 10, borderRadius: 8, border: "none", cursor: "pointer" }}>
        Añadir
      </button>
    </form>
  );
}
