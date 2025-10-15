import { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";

type Item = {
  id: string;
  title: string;
  start_at: string; // ISO
  end_at: string;   // ISO
  status: "planned" | "in_progress" | "done";
  notes?: string | null;
  updated_by?: string | null;
  updated_at?: string | null;
};

type NewItem = Omit<Item, "id" | "updated_at" | "updated_by">;

function toISO(input: string | Date) {
  if (input instanceof Date) return input.toISOString();
  // input viene de <input type="date"> o datetime-local
  // si es solo fecha "YYYY-MM-DD" añadimos "T00:00:00"
  const s = input.includes("T") ? input : `${input}T00:00:00`;
  return new Date(s).toISOString();
}

export default function Planificador() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // formulario
  const [title, setTitle] = useState("");
  const [start, setStart] = useState(""); // YYYY-MM-DD
  const [end, setEnd] = useState("");     // YYYY-MM-DD
  const [notes, setNotes] = useState("");

  // usuario (para updated_by opcional)
  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  // CARGA INICIAL + REALTIME
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setErr(null);
      const { data, error } = await supabase
        .from("planning_items")
        .select("*")
        .order("start_at", { ascending: true });
      if (error) setErr(error.message);
      if (!cancelled) {
        setItems((data as Item[]) ?? []);
        setLoading(false);
      }
    })();

    const channel = supabase
      .channel("realtime:planning_items")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "planning_items" },
        (payload: any) => {
          setItems((prev) => {
            if (payload.eventType === "INSERT") {
              const next = [...prev, payload.new as Item];
              return next.sort(
                (a, b) =>
                  new Date(a.start_at).getTime() - new Date(b.start_at).getTime()
              );
            }
            if (payload.eventType === "UPDATE") {
              const next = prev.map((it) =>
                it.id === payload.new.id ? (payload.new as Item) : it
              );
              return next.sort(
                (a, b) =>
                  new Date(a.start_at).getTime() - new Date(b.start_at).getTime()
              );
            }
            if (payload.eventType === "DELETE") {
              return prev.filter((it) => it.id !== payload.old.id);
            }
            return prev;
          });
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  // ACCIONES DB
  async function addItem() {
    setErr(null);
    if (!title.trim() || !start || !end) {
      setErr("Rellena título, inicio y fin.");
      return;
    }
    const payload: NewItem = {
      title: title.trim(),
      start_at: toISO(start),
      end_at: toISO(end),
      status: "planned",
      notes: notes || null,
    };
    const { error } = await supabase.from("planning_items").insert(payload);
    if (error) setErr(error.message);
    // no hace falta setItems: Realtime lo mete solo
    setTitle("");
    setStart("");
    setEnd("");
    setNotes("");
  }

  async function updateItem(id: string, patch: Partial<Item>) {
    setErr(null);
    const { error } = await supabase.from("planning_items").update(patch).eq("id", id);
    if (error) setErr(error.message);
  }

  async function removeItem(id: string) {
    setErr(null);
    const { error } = await supabase.from("planning_items").delete().eq("id", id);
    if (error) setErr(error.message);
  }

  // cambiar estado
  function nextStatus(s: Item["status"]): Item["status"] {
    if (s === "planned") return "in_progress";
    if (s === "in_progress") return "done";
    return "planned";
  }

  const sorted = useMemo(
    () =>
      [...items].sort(
        (a, b) =>
          new Date(a.start_at).getTime() - new Date(b.start_at).getTime()
      ),
    [items]
  );

  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
      <div style={{ width: 900, maxWidth: "96vw", color: "white" }}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
          <button
            onClick={async () => { await supabase.auth.signOut(); location.reload(); }}
            style={{ padding: "6px 10px", borderRadius: 8 }}
          >
            Cerrar sesión
          </button>
        </div>

        <div style={{ border: "1px solid #444", borderRadius: 10, padding: 12 }}>
          {err && (
            <div style={{ background: "#3a1a1a", border: "1px solid #663", padding: 10, borderRadius: 8, marginBottom: 10 }}>
              {err}
            </div>
          )}

          {/* FORMULARIO */}
          <div style={{ marginBottom: 12 }}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Título"
              style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #444", background: "#111", color: "white" }}
            />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
              <input
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                style={{ padding: 10, borderRadius: 8, border: "1px solid #444", background: "#111", color: "white" }}
              />
              <input
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                style={{ padding: 10, borderRadius: 8, border: "1px solid #444", background: "#111", color: "white" }}
              />
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notas (opcional)"
              rows={3}
              style={{ width: "100%", marginTop: 8, padding: 10, borderRadius: 8, border: "1px solid #444", background: "#111", color: "white" }}
            />
            <div style={{ textAlign: "center", marginTop: 10 }}>
              <button onClick={addItem} disabled={loading} style={{ padding: "8px 14px", borderRadius: 8 }}>
                Añadir
              </button>
            </div>
          </div>

          {/* LISTA */}
          {loading ? (
            <div style={{ padding: 10 }}>Cargando…</div>
          ) : sorted.length === 0 ? (
            <div style={{ padding: 10, color: "#bbb" }}>Sin elementos</div>
          ) : (
            <ul style={{ display: "grid", gap: 8, listStyle: "none", padding: 0, margin: 0 }}>
              {sorted.map((it) => (
                <li
                  key={it.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 12,
                    border: "1px solid #444",
                    borderRadius: 8,
                    padding: 8,
                    background:
                      it.status === "planned" ? "#1a1a33" :
                      it.status === "in_progress" ? "#2a331a" :
                      "#1a332a"
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{it.title}</div>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>
                      {new Date(it.start_at).toLocaleDateString()} → {new Date(it.end_at).toLocaleDateString()} · {it.status}
                    </div>
                    {it.notes && <div style={{ marginTop: 4, fontSize: 12, opacity: 0.9 }}>{it.notes}</div>}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      onClick={() => updateItem(it.id, { status: nextStatus(it.status) })}
                      style={{ padding: "6px 10px", borderRadius: 8 }}
                    >
                      Cambiar estado
                    </button>
                    <button
                      onClick={() => removeItem(it.id)}
                      style={{ padding: "6px 10px", borderRadius: 8, background: "#300", border: "1px solid #633", color: "white" }}
                    >
                      Borrar
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
