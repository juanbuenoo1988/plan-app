import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";

// ===== Tipos =====
type ItemStatus = "planned" | "in_progress" | "done";

type Item = {
  id: string;
  title: string;
  start_at: string; // ISO
  end_at: string;   // ISO
  status: ItemStatus;
  notes: string | null;
};

// ===== Utilidades fechas =====
// Input "yyyy-MM-dd" (propio de <input type="date">) -> ISO
function ymdToISO(ymd: string): string | null {
  if (!ymd) return null;
  // ymd = "2025-10-15"
  const d = new Date(ymd + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

// ISO -> "yyyy-MM-dd" para <input type="date">
function isoToYMD(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  // aaaa-mm-dd
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ===== Componente principal =====
export default function App() {
  // --- Sesión y UI ---
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // --- Datos / formulario ---
  const [items, setItems] = useState<Item[]>([]);
  const [title, setTitle] = useState("");
  const [startYMD, setStartYMD] = useState(""); // yyyy-MM-dd
  const [endYMD, setEndYMD] = useState("");     // yyyy-MM-dd
  const [notes, setNotes] = useState("");

  // ========= SESIÓN =========
  useEffect(() => {
    // leer sesión al arrancar
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      setSession(session ?? null);
    })();

    // escuchar cambios de sesión
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session ?? null);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  async function sendMagicLink() {
    try {
      setSending(true);
      setMsg(null);

      if (!email) {
        setMsg("Escribe tu correo.");
        return;
      }

      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          // IMPORTANTÍSIMO: que vuelva a tu dominio (o localhost en dev)
          emailRedirectTo: window.location.origin,
        },
      });
      if (error) throw error;

      setMsg("¡Enlace enviado! Revisa tu correo y haz clic en el enlace.");
    } catch (e: any) {
      setMsg(e.message ?? "No se pudo enviar el enlace.");
    } finally {
      setSending(false);
    }
  }

  async function logout() {
    try {
      await supabase.auth.signOut();
    } finally {
      // limpiar y recargar
      localStorage.clear();
      sessionStorage.clear();
      window.location.href = "/";
    }
  }

  // ========= CARGA DE ITEMS =========
  async function fetchItems() {
    const { data, error } = await supabase
      .from("planning_items")
      .select("id,title,start_at,end_at,status,notes")
      .order("start_at", { ascending: true });

    if (error) {
      setMsg(`Error cargando datos: ${error.message}`);
      return;
    }
    setItems((data ?? []) as Item[]);
  }

  // cargar cuando haya sesión
  useEffect(() => {
    if (!session) return;
    fetchItems();
    // (Opcional) Realtime: escuchar inserts/updates/deletes
    const channel = supabase
      .channel("realtime:planning_items")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "planning_items" },
        () => fetchItems()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [session]);

  // ========= INSERT =========
  async function addItem() {
    try {
      setMsg(null);

      if (!title.trim()) {
        setMsg("Pon un título.");
        return;
      }
      const startISO = ymdToISO(startYMD);
      const endISO = ymdToISO(endYMD);
      if (!startISO || !endISO) {
        setMsg("Fechas inválidas.");
        return;
      }

      const { error } = await supabase.from("planning_items").insert({
        title: title.trim(),
        start_at: startISO,
        end_at: endISO,
        status: "planned",
        notes: notes.trim() ? notes.trim() : null,
      });

      if (error) throw error;

      // limpiar formulario y recargar
      setTitle("");
      setStartYMD("");
      setEndYMD("");
      setNotes("");
      await fetchItems();
      setMsg("Guardado correctamente ✅");
    } catch (e: any) {
      setMsg(e.message ?? "No se pudo guardar.");
    }
  }

  // ========= UI =========
  if (!session) {
    // ---- VISTA LOGIN ----
    return (
      <div style={{ maxWidth: 520, margin: "60px auto", padding: 16 }}>
        <h2>Inicia sesión</h2>
        <p>Te enviaremos un enlace por correo.</p>

        {msg && (
          <div
            style={{
              background: "#f4f2e6",
              color: "#333",
              padding: "8px 10px",
              borderRadius: 6,
              marginBottom: 10,
              border: "1px solid #e0dcb8",
            }}
          >
            {msg}
          </div>
        )}

        <input
          type="email"
          placeholder="tu@correo.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{
            width: "100%",
            padding: 10,
            marginBottom: 10,
            borderRadius: 6,
            border: "1px solid #ccc",
          }}
        />
        <button
          onClick={sendMagicLink}
          disabled={sending}
          style={{
            padding: "8px 12px",
            borderRadius: 6,
            border: "1px solid #333",
            cursor: "pointer",
          }}
        >
          {sending ? "Enviando..." : "Enviarme enlace"}
        </button>
      </div>
    );
  }

  // ---- VISTA APP ----
  return (
    <div style={{ maxWidth: 900, margin: "30px auto", padding: 16 }}>
      <div style={{ textAlign: "right", marginBottom: 10 }}>
        <button
          onClick={logout}
          style={{
            padding: "6px 10px",
            borderRadius: 6,
            border: "1px solid #333",
            cursor: "pointer",
          }}
        >
          Cerrar sesión
        </button>
      </div>

      {msg && (
        <div
          style={{
            background: "#f4f2e6",
            color: "#333",
            padding: "8px 10px",
            borderRadius: 6,
            marginBottom: 10,
            border: "1px solid #e0dcb8",
          }}
        >
          {msg}
        </div>
      )}

      {/* Formulario */}
      <div
        style={{
          border: "1px solid #ccc",
          borderRadius: 8,
          padding: 12,
          marginBottom: 16,
        }}
      >
        <div style={{ marginBottom: 8 }}>
          <label style={{ display: "block", marginBottom: 4 }}>Título</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Título"
            style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #ccc" }}
          />
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: "block", marginBottom: 4 }}>Inicio</label>
            <input
              type="date"
              value={startYMD}
              onChange={(e) => setStartYMD(e.target.value)}
              style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #ccc" }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ display: "block", marginBottom: 4 }}>Fin</label>
            <input
              type="date"
              value={endYMD}
              onChange={(e) => setEndYMD(e.target.value)}
              style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #ccc" }}
            />
          </div>
        </div>

        <div style={{ marginBottom: 8 }}>
          <label style={{ display: "block", marginBottom: 4 }}>Notas (opcional)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #ccc" }}
          />
        </div>

        <button
          onClick={addItem}
          style={{
            padding: "8px 12px",
            borderRadius: 6,
            border: "1px solid #333",
            cursor: "pointer",
          }}
        >
          Añadir
        </button>
      </div>

      {/* Lista */}
      <div>
        {items.length === 0 ? (
          <p style={{ color: "#777" }}>Sin elementos</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
            {items.map((it) => (
              <li
                key={it.id}
                style={{
                  border: "1px solid #ddd",
                  borderRadius: 8,
                  padding: 10,
                  display: "grid",
                  gap: 6,
                }}
              >
                <div style={{ fontWeight: 600 }}>{it.title}</div>
                <div style={{ fontSize: 14, color: "#444" }}>
                  {isoToYMD(it.start_at)} → {isoToYMD(it.end_at)} · Estado:{" "}
                  <span style={{ fontWeight: 600 }}>{it.status}</span>
                </div>
                {it.notes ? <div style={{ whiteSpace: "pre-wrap" }}>{it.notes}</div> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
