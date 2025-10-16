import { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";

type Item = {
  id: string;
  title: string;
  start_at: string | null;
  end_at: string | null;
  status: "planned" | "in_progress" | "done";
  notes: string | null;
  updated_by: string | null;
  updated_at: string | null;
};

type Role = "viewer" | "editor" | "admin" | null;

function nextStatus(s: Item["status"]): Item["status"] {
  if (s === "planned") return "in_progress";
  if (s === "in_progress") return "done";
  return "planned";
}

export default function App() {
  // Sesión y rol
  const [loadingSession, setLoadingSession] = useState(true);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [role, setRole] = useState<Role>(null);

  // Datos
  const [items, setItems] = useState<Item[]>([]);
  const [cargandoLista, setCargandoLista] = useState(false);

  // Formulario nuevo
  const [title, setTitle] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [notes, setNotes] = useState("");

  const puedeEditar = role === "editor" || role === "admin";

  // -------------- AUTENTICACIÓN --------------
  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      const sess = data.session;
      setUserId(sess?.user?.id ?? null);

      if (sess?.user?.id) {
        // Leer rol del perfil
        const { data: profile } = await supabase
          .from("profiles")
          .select("role")
          .eq("id", sess.user.id)
          .maybeSingle();

        setRole((profile?.role as Role) ?? "viewer");
      } else {
        setRole(null);
      }
      setLoadingSession(false);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange(async (_evt, sess) => {
      setUserId(sess?.user?.id ?? null);
      if (sess?.user?.id) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("role")
          .eq("id", sess.user.id)
          .maybeSingle();
        setRole((profile?.role as Role) ?? "viewer");
      } else {
        setRole(null);
      }
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  async function sendMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!email) return setMsg("Escribe un correo");
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: window.location.origin,
      },
    });
    if (error) setMsg(error.message);
    else setMsg("Te he enviado un enlace de login a tu correo.");
  }

  async function cerrarSesion() {
    await supabase.auth.signOut();
    setItems([]);
  }

  // -------------- CARGAR LISTA --------------
  const cargar = useMemo(
    () => async () => {
      setCargandoLista(true);
      const { data, error } = await supabase
        .from("planning_items")
        .select("*")
        .order("start_at", { ascending: true });
      if (!error && data) setItems(data as Item[]);
      setCargandoLista(false);
    },
    []
  );

  useEffect(() => {
    if (!loadingSession && userId) {
      cargar();
      // Realtime para refrescar
      const channel = supabase
        .channel("realtime:planning_items")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "planning_items" },
          () => cargar()
        )
        .subscribe();

      return () => {
        supabase.removeChannel(channel);
      };
    }
  }, [loadingSession, userId, cargar]);

  // -------------- CRUD --------------
  async function addItem() {
    setMsg(null);
    if (!puedeEditar) {
      return setMsg("No tienes permisos para añadir. Pide rol editor/admin.");
    }
    if (!title.trim()) return setMsg("El título es obligatorio.");

    const payload = {
      title: title.trim(),
      start_at: startAt ? new Date(startAt).toISOString() : null,
      end_at: endAt ? new Date(endAt).toISOString() : null,
      status: "planned" as const,
      notes: notes.trim() || null,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase.from("planning_items").insert(payload);
    if (error) setMsg(error.message);
    else {
      setTitle("");
      setStartAt("");
      setEndAt("");
      setNotes("");
    }
  }

  async function toggleEstado(it: Item) {
    setMsg(null);
    if (!puedeEditar) {
      return setMsg("No tienes permisos para editar. Pide rol editor/admin.");
    }
    const nuevo = nextStatus(it.status);
    const { error } = await supabase
      .from("planning_items")
      .update({
        status: nuevo,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", it.id);
    if (error) setMsg(error.message);
  }

  async function borrar(it: Item) {
    setMsg(null);
    if (!puedeEditar) {
      return setMsg("No tienes permisos para borrar. Pide rol editor/admin.");
    }
    const { error } = await supabase
      .from("planning_items")
      .delete()
      .eq("id", it.id);
    if (error) setMsg(error.message);
  }

  // -------------- RENDER --------------
  if (loadingSession) return <div style={{ padding: 24 }}>Cargando…</div>;

  if (!userId) {
    return (
      <div style={{ maxWidth: 720, margin: "40px auto" }}>
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

  return (
    <div style={{ maxWidth: 900, margin: "32px auto", padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={cerrarSesion}>Cerrar sesión</button>
      </div>

      <h2>Planificación</h2>
      <p>
        Rol: <b>{role ?? "?"}</b> {puedeEditar ? "(puedes editar)" : "(solo lectura)"}
      </p>
      {msg && <p style={{ color: "crimson" }}>{msg}</p>}

      {/* Formulario nuevo */}
      <div
        style={{
          border: "1px solid #ccc",
          borderRadius: 6,
          padding: 12,
          marginBottom: 16,
        }}
      >
        <label>Título</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Título…"
          style={{ width: "100%", padding: 8, marginBottom: 8 }}
        />

        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <label>Inicio</label>
            <input
              type="date"
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
              style={{ width: "100%", padding: 8 }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label>Fin</label>
            <input
              type="date"
              value={endAt}
              onChange={(e) => setEndAt(e.target.value)}
              style={{ width: "100%", padding: 8 }}
            />
          </div>
        </div>

        <label style={{ marginTop: 8, display: "block" }}>Notas (opcional)</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          style={{ width: "100%", padding: 8, height: 80 }}
        />

        <div style={{ marginTop: 8 }}>
          <button onClick={addItem}>Añadir</button>
        </div>
      </div>

      {/* Lista */}
      <h3>
        {cargandoLista ? "Cargando…" : items.length ? "Tareas" : "Sin elementos"}
      </h3>

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {items.map((it) => (
          <li
            key={it.id}
            style={{
              border: "1px solid #ddd",
              borderRadius: 6,
              padding: 12,
              marginBottom: 8,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <strong>{it.title}</strong>
              <span>
                Estado: <b>{it.status}</b>
              </span>
            </div>
            <div style={{ color: "#666", fontSize: 14, marginTop: 4 }}>
              {it.start_at?.slice(0, 10)} — {it.end_at?.slice(0, 10)}
            </div>
            {it.notes && <div style={{ marginTop: 6 }}>{it.notes}</div>}

            <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
              <button onClick={() => toggleEstado(it)} disabled={!puedeEditar}>
                Cambiar estado
              </button>
              <button onClick={() => borrar(it)} disabled={!puedeEditar}>
                Borrar
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

