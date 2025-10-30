// src/Planificador.tsx
import React, { useMemo, useRef, useState, useEffect } from "react";
import { supabase } from "./lib/supabase";
import {
  addDays,
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  getDay,
  isBefore,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { es } from "date-fns/locale";

/* ===================== Configuración ===================== */
const PASSWORD = "taller2025"; // ← cámbiala por la que quieras
const STORAGE_KEY = "planificador:v1";

// Todos verán/editarán el mismo plan (tenant único)
const TENANT_ID = "00000000-0000-0000-0000-000000000001";
/* ===================== Error Boundary ===================== */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; info?: string }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, info: "" };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: any) {
    this.setState({ info: String(error?.message || error) });
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 20, color: "#111", background: "#fff", borderRadius: 8, margin: 16 }}>
          <h2>Algo ha fallado 🫠</h2>
          <p>La aplicación ha capturado un error y se ha detenido el renderizado de esa parte.</p>
          {this.state.info ? (
            <pre style={{ whiteSpace: "pre-wrap", background: "#f3f4f6", padding: 12, borderRadius: 8 }}>
              {this.state.info}
            </pre>
          ) : null}
          <p style={{ marginTop: 8 }}>Recarga la página. Si vuelve a pasar, copia el texto del error y mándamelo.</p>
        </div>
      );
    }
    return this.props.children as any;
  }
}

/* ===================== Tipos ===================== */
type Worker = {
  id: string;
  nombre: string;
  extraDefault: number;
  sabadoDefault: boolean;
};

type DayOverride = { extra: number; sabado: boolean };

type TaskSlice = {
  id: string;
  taskId: string;
  producto: string;
  fecha: string;     // YYYY-MM-DD
  horas: number;
  trabajadorId: string;
  color: string;
};

type NewTaskForm = {
  producto: string;
  horasTotales: number;
  trabajadorId: string;
  fechaInicio: string; // YYYY-MM-DD
};

type OverridesState = Record<string, Record<string, DayOverride>>;
type ProductDescriptions = Record<string, string>;

// === Estado que guardaremos en Supabase (todo el planificador) ===
type CloudState = {
  workers: Worker[];                 // trabajadores
  slices: TaskSlice[];               // bloques del calendario
  overrides: OverridesState;         // extras/sábados por día y trabajador
  descs: ProductDescriptions;        // descripciones de productos
  base?: string;                     // mes base (guardado como texto ISO)
  locked?: boolean;                  // si el planificador está bloqueado
};

/* ===================== Util ===================== */
const fmt = (d: Date | null | undefined) => {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return "";
  try { return format(d, "yyyy-MM-dd"); } catch { return ""; }
};

function monthYear(d: Date | null | undefined): string {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return "";
  try {
    const s = format(d, "LLLL yyyy", { locale: es });
    return s ? s[0].toUpperCase() + s.slice(1) : "";
  } catch { return ""; }
}

const weekDaysHeader = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const PX_PER_HOUR = 20;
const URGENT_COLOR = "#f59e0b";

function monthGrid(date: Date) {
  const start = startOfWeek(startOfMonth(date), { weekStartsOn: 1 });
  const end = endOfWeek(endOfMonth(date), { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start, end });
  const weeks: Date[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return { start, end, weeks };
}

// Hash muy simple para color
function hashInt(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return Math.abs(h);
}

// Color distinto por BLOQUE (taskId)
function colorFromId(id: string) {
  const hue = hashInt(id) % 360;
  return `hsl(${hue} 70% 45%)`;
}

// Capacidad diaria (respeta overrides)
function capacidadDia(worker: Worker, date: Date, overrides: OverridesState): number {
  const wd = getDay(date); // 0=Dom, 6=Sáb
  const f = fmt(date);
  const ow = (f && overrides[worker.id]?.[f]) || undefined;

  if (wd === 6) return (ow?.sabado ?? worker.sabadoDefault) ? 8 : 0; // sábado
  if (wd === 0) return 0;                                           // domingo

  const base = wd === 5 ? 6 : 8.5;                                  // V:6, L–J:8.5
  const extra = ow?.extra ?? worker.extraDefault ?? 0;
  const total = base + Math.max(0, Number(isFinite(extra) ? extra : 0));
  return Math.max(0, Math.round(total * 2) / 2);
}

function usadasEnDia(slices: TaskSlice[], workerId: string, date: Date) {
  const f = fmt(date);
  if (!f) return 0;
  return slices
    .filter((s) => s.trabajadorId === workerId && s.fecha === f)
    .reduce((a, s) => a + s.horas, 0);
}

/* ===================== Replanificación / colas ===================== */
type QueueItem = { producto: string; horas: number; color: string; taskId: string };

function pushOrMergeSameDay(out: TaskSlice[], add: TaskSlice) {
  const i = out.findIndex(
    (s) => s.trabajadorId === add.trabajadorId && s.taskId === add.taskId && s.fecha === add.fecha
  );
  if (i >= 0) {
    out[i] = { ...out[i], horas: Math.round((out[i].horas + add.horas) * 2) / 2 };
  } else {
    out.push(add);
  }
}

function aggregateToQueue(items: TaskSlice[]): QueueItem[] {
  const map = new Map<string, QueueItem>();
  const order: string[] = [];
  for (const t of items) {
    if (!map.has(t.taskId)) {
      map.set(t.taskId, { producto: t.producto, horas: 0, color: t.color, taskId: t.taskId });
      order.push(t.taskId);
    }
    const cur = map.get(t.taskId)!;
    cur.horas = Math.round((cur.horas + t.horas) * 2) / 2;
  }
  return order.map((id) => map.get(id)!);
}

function compactFrom(
  worker: Worker,
  startF: string,
  overrides: OverridesState,
  allSlices: TaskSlice[]
): TaskSlice[] {
  const keepBefore = allSlices
    .filter((s) => s.trabajadorId === worker.id && s.fecha < startF)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  const tail = allSlices
    .filter((s) => s.trabajadorId === worker.id && s.fecha >= startF)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  const queue = aggregateToQueue(tail);
  return reflowFrom(worker, new Date(startF), overrides, keepBefore, queue);
}

function reflowFrom(
  worker: Worker,
  startDate: Date,
  overrides: OverridesState,
  keepBefore: TaskSlice[],
  queue: QueueItem[]
): TaskSlice[] {
  const out: TaskSlice[] = [...keepBefore];
  let cursor = startDate;
  if (isNaN(startDate.getTime?.() ?? NaN)) return out;

  while (queue.length) {
    const cap = capacidadDia(worker, cursor, overrides);
    const used = usadasEnDia(out, worker.id, cursor);
    let libre = Math.max(0, Math.floor((cap - used) * 2) / 2);

    if (libre <= 0) {
      cursor = addDays(cursor, 1);
      continue;
    }

    const q = queue[0];
    const take = Math.min(q.horas, libre);
    if (take > 0) {
      pushOrMergeSameDay(out, {
        id: "S" + Math.random().toString(36).slice(2, 9),
        taskId: q.taskId,
        producto: q.producto,
        fecha: fmt(cursor),
        horas: take,
        trabajadorId: worker.id,
        color: q.color,
      });
      q.horas = Math.round((q.horas - take) * 2) / 2;
      libre = Math.round((libre - take) * 2) / 2;
    }

    if (q.horas <= 0.0001) queue.shift();
    if (libre <= 0.0001) cursor = addDays(cursor, 1);
  }

  return out;
}

// Planificación de un bloque (crea taskId/color únicos por bloque)
function planificarBloqueAuto(
  producto: string,
  horasTotales: number,
  worker: Worker,
  fechaInicio: Date,
  baseMes: Date,
  existentes: TaskSlice[],
  overrides: OverridesState
): TaskSlice[] {
  const taskId = "T" + Math.random().toString(36).slice(2, 8);
  const color = colorFromId(taskId); // color por BLOQUE
  let restante = Math.max(0, Math.round(Number(horasTotales) * 2) / 2);
  const out: TaskSlice[] = [];

  const { end } = monthGrid(baseMes);
  const visibleStart = startOfWeek(startOfMonth(baseMes), { weekStartsOn: 1 });
  const startScan = isNaN(fechaInicio.getTime?.() ?? NaN)
    ? visibleStart
    : isBefore(fechaInicio, visibleStart) ? visibleStart : fechaInicio;

  const dias = eachDayOfInterval({ start: startScan, end });

  for (const d of dias) {
    if (restante <= 0) break;
    const cap = capacidadDia(worker, d, overrides);
    if (cap <= 0) continue;
    const ya = usadasEnDia([...existentes, ...out], worker.id, d);
    const libre = Math.max(0, cap - ya);
    if (libre <= 0) continue;

    const h = Math.min(restante, Math.floor(libre * 2) / 2);
    if (h > 0) {
      pushOrMergeSameDay(out, {
        id: "S" + Math.random().toString(36).slice(2, 9),
        taskId,
        producto,
        fecha: fmt(d),
        horas: h,
        trabajadorId: worker.id,
        color,
      });
      restante = Math.round((restante - h) * 2) / 2;
    }
  }

  let cursor = endOfMonth(baseMes);
  while (restante > 0) {
    cursor = addDays(cursor, 1);
    const cap = capacidadDia(worker, cursor, overrides);
    const h = Math.min(restante, Math.floor(cap * 2) / 2);
    if (h > 0) {
      pushOrMergeSameDay(out, {
        id: "S" + Math.random().toString(36).slice(2, 9),
        taskId,
        producto,
        fecha: fmt(cursor),
        horas: h,
        trabajadorId: worker.id,
        color,
      });
      restante = Math.round((restante - h) * 2) / 2;
    }
  }

  return out;
}

/* ===================== Componente raíz ===================== */
export default function Planificador() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}

/* ===================== App ===================== */
function AppInner() {
  const [base, setBase] = useState(new Date());
  const { weeks } = useMemo(() => monthGrid(base), [base]);

  
  const [locked, setLocked] = useState(true); // bloqueado por defecto
  const canEdit = !locked;

  const [workers, setWorkers] = useState<Worker[]>([
    { id: "W1", nombre: "ANGEL MORGADO", extraDefault: 0, sabadoDefault: false },
    { id: "W2", nombre: "ANTONIO MONTILLA", extraDefault: 0, sabadoDefault: false },
    { id: "W3", nombre: "DANIEL MORGADO", extraDefault: 0, sabadoDefault: false },
    { id: "W4", nombre: "FIDEL RODRIGO", extraDefault: 0, sabadoDefault: false },
    { id: "W5", nombre: "LUCAS PRIETO", extraDefault: 0, sabadoDefault: false },
    { id: "W6", nombre: "LUIS AGUADO", extraDefault: 0, sabadoDefault: false },
    { id: "W7", nombre: "VICTOR HERNANDEZ", extraDefault: 0, sabadoDefault: false },
  ]);
  const [nuevoTrabajador, setNuevoTrabajador] = useState("");

  const [overrides, setOverrides] = useState<OverridesState>({});
  const [slices, setSlices] = useState<TaskSlice[]>([]);

  const [descs, setDescs] = useState<ProductDescriptions>({});
  const [descNombre, setDescNombre] = useState("");
  const [descTexto, setDescTexto] = useState("");
  const [editKey, setEditKey] = useState<string | null>(null);

  const [form, setForm] = useState<NewTaskForm>({
    producto: "",
    horasTotales: 0,
    trabajadorId: "W1",
    fechaInicio: fmt(new Date()),
  });

const orderedWorkers = useMemo(() => {
  const arr = [...workers];
  if (!form?.trabajadorId) return arr;
  arr.sort((a, b) => {
    if (a.id === form.trabajadorId) return -1;
    if (b.id === form.trabajadorId) return 1;
    return 0;
  });
  return arr;
}, [workers, form.trabajadorId]); 

  // ⬇️ 3.3-C (estados de sesión/carga en la nube)
  const [userId, setUserId] = useState<string | null>(null);
  const [loadingCloud, setLoadingCloud] = useState(false);
  // Estado de guardado en la nube
  const [savingCloud, setSavingCloud] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loginEmail, setLoginEmail] = useState("");
  const [sendingLink, setSendingLink] = useState(false);
  const [authMsg, setAuthMsg] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  // Referencias para "debounce" y última instantánea guardada
  const saveTimer = useRef<number | null>(null);
  const lastSavedRef = useRef<string>("");

  type PrintMode = "none" | "monthly" | "daily" | "dailyAll";
  const [printMode, setPrintMode] = useState<PrintMode>("none");
  const [printWorker, setPrintWorker] = useState<string>("W1");
  const [printDate, setPrintDate] = useState<string>(fmt(new Date()));

  

  // 🔽🔽🔽 Pega aquí todo este bloque completo 🔽🔽🔽

  function flattenOverrides(ov: OverridesState) {
    const rows: Array<{ worker_id: string; fecha: string; extra: number; sabado: boolean }> = [];
    Object.entries(ov).forEach(([workerId, byDate]) => {
      Object.entries(byDate).forEach(([fecha, v]) => {
        rows.push({ worker_id: workerId, fecha, extra: v.extra, sabado: v.sabado });
      });
    });
    return rows;
  }

  // === NUEVO: helper seguro para leer del almacenamiento local ===
  function safeLocal<T>(k: string, fallback: T) {
    try { const s = localStorage.getItem(k); return s ? (JSON.parse(s) as T) : fallback; }
    catch { return fallback; }
  }

  // Crea datos base si el usuario aún no tiene nada en la nube
  async function seedIfEmpty(uid: string) {
    try {
      // ¿Hay trabajadores?
      const { data: existingW, error: wErr } = await supabase
        .from("workers")
        .select("id")
        .eq("tenant_id", TENANT_ID)
        .limit(1);

      if (wErr) {
        console.error("seedIfEmpty/workers select error:", wErr);
        return;
      }

      if (!existingW || existingW.length === 0) {
        // Inserta un set inicial de trabajadores (puedes ajustar nombres/IDs)
        const initialWorkers = [
          { user_id: uid, tenant_id: TENANT_ID, id: "W1", nombre: "ANGEL MORGADO",  extra_default: 0, sabado_default: false },
          { user_id: uid, tenant_id: TENANT_ID, id: "W2", nombre: "ANTONIO MONTILLA", extra_default: 0, sabado_default: false },
          { user_id: uid, tenant_id: TENANT_ID, id: "W3", nombre: "DANIEL MORGADO",  extra_default: 0, sabado_default: false },
          { user_id: uid, tenant_id: TENANT_ID, id: "W4", nombre: "FIDEL RODRIGO",    extra_default: 0, sabado_default: false },
          { user_id: uid, tenant_id: TENANT_ID, id: "W5", nombre: "LUCAS PRIETO",     extra_default: 0, sabado_default: false },
          { user_id: uid, tenant_id: TENANT_ID, id: "W6", nombre: "LUIS AGUADO",      extra_default: 0, sabado_default: false },
          { user_id: uid, tenant_id: TENANT_ID, id: "W7", nombre: "VICTOR HERNANDEZ", extra_default: 0, sabado_default: false },
        ];

        const { error: insErr } = await supabase.from("workers").insert(initialWorkers);
        if (insErr) {
          console.error("seedIfEmpty/workers insert error:", insErr);
        } else {
          console.info("seedIfEmpty: trabajadores iniciales insertados");
        }
      }
    } catch (e) {
      console.error("seedIfEmpty() exception:", e);
    }
  }

  // CARGA TODO DE SUPABASE PARA ESTE USUARIO
  async function loadAll(uid: string) {
    try {
      // 1) Trabajadores
      const { data: wData, error: wErr } = await supabase
        .from("workers")
        .select("*")
        .eq("tenant_id", TENANT_ID)
        .order("nombre", { ascending: true });

      if (wErr) console.error("workers error:", wErr);
      if (Array.isArray(wData) && wData.length > 0) {
        setWorkers(
          wData.map((r: any) => ({
            id: r.id,
            nombre: r.nombre,
            extraDefault: Number(r.extra_default ?? 0),
            sabadoDefault: !!r.sabado_default,
          }))
        );
      }

      // 2) Bloques / Slices
      const { data: sData, error: sErr } = await supabase
        .from("task_slices")
        .select("*")
        .eq("tenant_id", TENANT_ID);

      if (sErr) console.error("task_slices error:", sErr);
      if (sData) {
        setSlices(
          sData.map((r: any) => ({
            id: r.id,
            taskId: r.task_id,
            producto: r.producto,
            fecha: r.fecha,
            horas: Number(r.horas),
            trabajadorId: r.trabajador_id,
            color: r.color,
          }))
        );
      }

      // 3) Overrides (extras/sábado)
      const { data: oData, error: oErr } = await supabase
        .from("day_overrides")
        .select("*")
        .eq("tenant_id", TENANT_ID);

      if (oErr) console.error("day_overrides error:", oErr);
      if (oData) {
        const obj: Record<string, Record<string, { extra: number; sabado: boolean }>> = {};
        for (const r of oData as any[]) {
          if (!obj[r.worker_id]) obj[r.worker_id] = {};
          obj[r.worker_id][r.fecha] = {
            extra: Number(r.extra ?? 0),
            sabado: !!r.sabado,
          };
        }
        setOverrides(obj);
      }

      const { data: dData, error: dErr } = await supabase
        .from("product_descs")
        .select("*")
        .eq("tenant_id", TENANT_ID);

      if (dErr) console.error("product_descs error:", dErr);
      if (dData) {
        const map: Record<string, string> = {};
        for (const r of dData as any[]) {
          map[r.nombre] = r.texto ?? "";
        }
        setDescs(map);
      }
    } catch (e) {
      console.error("loadAll() error:", e);
    }
  }

  async function saveAll(uid: string) {
    setSaveError(null);
    setSavingCloud(true);
    try {
      // 1) Trabajadores
      const wRows = workers.map(w => ({
        user_id: uid,
        id: w.id,
        nombre: w.nombre,
        extra_default: w.extraDefault,
        sabado_default: w.sabadoDefault,
        tenant_id: TENANT_ID,
      }));

      if (wRows.length) {
        const { error } = await supabase.from("workers").upsert(wRows, { onConflict: "tenant_id,id" });
        if (error) throw error;
      }

      // 2) Slices (snapshot)
      const sRows = slices.map(s => ({
        id: s.id,
        task_id: s.taskId,
        producto: s.producto,
        fecha: s.fecha,
        horas: s.horas,
        trabajador_id: s.trabajadorId,
        color: s.color,
        user_id: uid,
        tenant_id: TENANT_ID,
      }));

      await supabase.from("task_slices").delete().eq("tenant_id", TENANT_ID);
      if (sRows.length) {
        const { error } = await supabase.from("task_slices").insert(sRows);
        if (error) throw error;
      }

      // 3) Overrides
      const oRows = flattenOverrides(overrides).map(r => ({
        ...r,
        user_id: uid,
        tenant_id: TENANT_ID,
      }));
      await supabase.from("day_overrides").delete().eq("tenant_id", TENANT_ID);
      if (oRows.length) {
        const { error } = await supabase.from("day_overrides").insert(oRows);
        if (error) throw error;
      }

      // 4) Descripciones
      const dRows = Object.entries(descs).map(([nombre, texto]) => ({
        nombre,
        texto,
        user_id: uid,
        tenant_id: TENANT_ID,
      }));

      await supabase.from("product_descs").delete().eq("tenant_id", TENANT_ID);
      if (dRows.length) {
        const { error } = await supabase.from("product_descs").insert(dRows);
        if (error) throw error;
      }
    } catch (e: any) {
      setSaveError(e.message ?? String(e));
      throw e;
    } finally {
      setSavingCloud(false);
    }
  }

  // Detecta sesión y carga
  useEffect(() => {
    let mounted = true;

    async function init() {
      const { data } = await supabase.auth.getSession();
      const uid = data.session?.user?.id ?? null;
      const mail = data.session?.user?.email ?? null;

      if (!mounted) return;

      setUserId(uid);
      setUserEmail(mail);

      if (uid) {
        try {
          setLoadingCloud(true);
          await seedIfEmpty(uid);
          await loadAll(uid);
        } finally {
          if (mounted) setLoadingCloud(false);
        }
      } else {
        // carga local si no hay sesión
        const snap = safeLocal<any>(STORAGE_KEY, null as any);
        if (snap) {
          setWorkers(snap.workers ?? []);
          setSlices(snap.slices ?? []);
          setOverrides(snap.overrides ?? {});
          setDescs(snap.descs ?? {});
        }
      }
    }

    init();

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!mounted) return;
      const uid = session?.user?.id ?? null;
      const mail = session?.user?.email ?? null;
      setUserId(uid);
      setUserEmail(mail);

      if (uid) {
        try {
          setLoadingCloud(true);
          await seedIfEmpty(uid);
          await loadAll(uid);
        } finally {
          setLoadingCloud(false);
        }
      }
    });

    return () => {
      mounted = false;
      sub?.subscription?.unsubscribe();
    };
  }, []);

  // Autosave
  useEffect(() => {
    if (!userId) return;
    if (loadingCloud) return;

    const snapshot = JSON.stringify({ workers, slices, overrides, descs });
    if (snapshot === lastSavedRef.current) return;

    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      try {
        await saveAll(userId);
        lastSavedRef.current = snapshot;
      } catch {
        /* error ya gestionado */
      }
    }, 800);

    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); };
  }, [workers, slices, overrides, descs, userId, loadingCloud]);

  // Guardado local sin sesión
  useEffect(() => {
    if (userId) return;
    const snapshot = JSON.stringify({ workers, slices, overrides, descs });
    try { localStorage.setItem(STORAGE_KEY, snapshot); } catch {}
  }, [workers, slices, overrides, descs, userId]);

  useEffect(() => {
  const t = setTimeout(() => {
    try {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {}
  }, 50);
  return () => clearTimeout(t);
}, [form.trabajadorId]);

  function triggerPrint(mode: PrintMode) {
    setPrintMode(mode);
    setTimeout(() => window.print(), 80);
    setTimeout(() => setPrintMode("none"), 600);
  }

  // Bloqueo simple
  function tryUnlock() {
    const p = prompt("Introduce la contraseña para editar:");
    if (p === PASSWORD) setLocked(false);
    else alert("Contraseña incorrecta");
  }
  function lock() {
    setLocked(true);
  }

  // Login/Logout
  async function sendMagicLink() {
    setAuthMsg(null);
    const email = loginEmail.trim();
    if (!email) { setAuthMsg("Escribe tu email."); return; }
    setSendingLink(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: window.location.origin,
        },
      });
      if (error) throw error;
      setAuthMsg("Te envié un enlace mágico. Revisa tu correo.");
    } catch (e: any) {
      setAuthMsg(e.message ?? String(e));
    } finally {
      setSendingLink(false);
    }
  }
  async function logout() {
    await supabase.auth.signOut();
  }

  // Crear bloque
  function crearBloque() {
    if (!canEdit) return;
    const w = workers.find((x) => x.id === form.trabajadorId);
    if (!w) return;
    const horas = Number(form.horasTotales);
    if (!form.producto.trim() || !isFinite(horas) || horas <= 0) return;

    const start = new Date(form.fechaInicio);
    const plan = planificarBloqueAuto(
      form.producto.trim(),
      Math.max(0.5, Math.round(horas * 2) / 2),
      w,
      start,
      base,
      slices,
      overrides
    );
    setSlices((prev) => [...prev, ...plan]);
  }

  // Trabajadores
  function addWorker() {
    if (!canEdit) return;
    const name = nuevoTrabajador.trim();
    if (!name) return;
    const id = "W" + Math.random().toString(36).slice(2, 6);
    setWorkers((prev) => [...prev, { id, nombre: name, extraDefault: 0, sabadoDefault: false }]);
    setNuevoTrabajador("");
  }
  function editWorker(id: string, patch: Partial<Worker>) {
    if (!canEdit) return;
    setWorkers((prev) => prev.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  }
  function deleteWorker(id: string) {
    if (!canEdit) return;
    const w = workers.find(x => x.id === id);
    const name = w?.nombre || id;
    if (!confirm(`¿Eliminar a "${name}" y todas sus asignaciones? Esta acción no se puede deshacer.`)) return;

    setWorkers(prev => prev.filter(x => x.id !== id));
    setSlices(prev => prev.filter(s => s.trabajadorId !== id));
    setOverrides(prev => { const copy = { ...prev }; delete copy[id]; return copy; });
  }

  // Drag & Drop
  const dragIdRef = useRef<string | null>(null);
  function onDragStart(e: React.DragEvent, sliceId: string) {
    if (!canEdit) { e.preventDefault(); return; }
    dragIdRef.current = sliceId;
    e.dataTransfer.effectAllowed = "move";
  }
  function onDropDay(e: React.DragEvent, workerId: string, date: Date) {
    if (!canEdit) return;
    e.preventDefault();
    const sliceId = dragIdRef.current;
    dragIdRef.current = null;
    if (!sliceId) return;
    setSlices((prev) =>
      prev.map((s) => (s.id === sliceId ? { ...s, trabajadorId: workerId, fecha: fmt(date) } : s))
    );
  }
  function onDragOver(e: React.DragEvent) {
    if (!canEdit) return;
    e.preventDefault();
  }

  // Doble clic en celda → extras/sábado
  function editOverrideForDay(worker: Worker, date: Date) {
    if (!canEdit) return;
    const f = fmt(date);
    if (!f) return;
    const ow = overrides[worker.id]?.[f] ?? { extra: worker.extraDefault, sabado: worker.sabadoDefault };

    const extraStr = prompt(`Horas extra para ${worker.nombre} el ${f} (solo L–V):`, String(ow.extra));
    if (extraStr === null) return;
    const extra = Number(extraStr);
    if (!isFinite(extra) || extra < 0 || extra > 8) return;

    let sab = ow.sabado;
    if (getDay(date) === 6) {
      const resp = prompt(`¿Trabaja el sábado ${f}? (sí=1 / no=0):`, sab ? "1" : "0");
      if (resp === null) return;
      sab = resp.trim() === "1";
    }

    const nextOverrides: OverridesState = (() => {
      const byWorker = { ...(overrides[worker.id] || {}) };
      byWorker[f] = { extra, sabado: sab };
      return { ...overrides, [worker.id]: byWorker };
    })();

    setOverrides(nextOverrides);

    setSlices((prev) => {
      const newPlan = compactFrom(worker, f, nextOverrides, prev);
      const others = prev.filter((s) => s.trabajadorId !== worker.id);
      return [...others, ...newPlan];
    });
  }

  // Borrar tramo / bloque
  function removeSlice(id: string) {
    if (!canEdit) return;
    const victim = slices.find((s) => s.id === id);
    setSlices((prev) => {
      const filtered = prev.filter((s) => s.id !== id);
      if (!victim) return filtered;

      const w = workers.find((x) => x.id === victim.trabajadorId);
      if (!w) return filtered;

      const newPlan = compactFrom(w, victim.fecha, overrides, filtered);
      const others = filtered.filter((s) => s.trabajadorId !== w.id);
      return [...others, ...newPlan];
    });
  }
  function removeTask(taskId: string, workerId: string) {
    if (!canEdit) return;
    if (!confirm("¿Eliminar todo el bloque (producto) para este trabajador?")) return;
    const w = workers.find((x) => x.id === workerId);
    if (!w) return;

    setSlices((prev) => {
      const toRemove = prev.filter((s) => s.taskId === taskId && s.trabajadorId === workerId);
      const filtered = prev.filter((s) => !(s.taskId === taskId && s.trabajadorId === workerId));
      if (!toRemove.length) return filtered;

      const startF = toRemove.reduce((m, s) => (s.fecha < m ? s.fecha : m), toRemove[0].fecha);
      const newPlan = compactFrom(w, startF, overrides, filtered);
      const others = filtered.filter((s) => s.trabajadorId !== w.id);

      return [...others, ...newPlan];
    });
  }

  // Urgencia
  function addManualHere(worker: Worker, date: Date) {
    if (!canEdit) return;
    const prod = prompt("Producto a insertar:", "Urgente");
    if (!prod) return;
    const hStr = prompt("Horas de ese producto:", "4");
    const h = Number(hStr);
    if (!isFinite(h) || h <= 0) return;

    const delTrabajador = slices
      .filter((s) => s.trabajadorId === worker.id)
      .sort((a, b) => a.fecha.localeCompare(b.fecha));

    const keepBefore = delTrabajador.filter((s) => s.fecha < fmt(date));
    const tail = delTrabajador.filter((s) => s.fecha >= fmt(date));

    const urgent: QueueItem = {
      producto: prod.trim(),
      horas: Math.round(h * 2) / 2,
      color: URGENT_COLOR,        // amarillo para urgencias
      taskId: "T" + Math.random().toString(36).slice(2, 8),
    };

    const queue: QueueItem[] = [urgent, ...aggregateToQueue(tail)];

    const newPlan = reflowFrom(worker, date, overrides, keepBefore, queue);
    const others = slices.filter((s) => s.trabajadorId !== worker.id);
    setSlices([...others, ...newPlan]);
  }

  // Descripciones CRUD
  function saveDesc() {
    if (!canEdit) return;
    const key = (editKey ?? descNombre).trim();
    if (!key) return;
    setDescs((p) => ({ ...p, [key]: descTexto.trim() }));
    setDescNombre("");
    setDescTexto("");
    setEditKey(null);
  }
  function editDesc(key: string) {
    if (!canEdit) return;
    setEditKey(key);
    setDescNombre(key);
    setDescTexto(descs[key] || "");
  }
  function deleteDesc(key: string) {
    if (!canEdit) return;
    const d = { ...descs };
    delete d[key];
    setDescs(d);
    if (editKey === key) {
      setEditKey(null);
      setDescNombre("");
      setDescTexto("");
    }
  }

  // Editor de bloques por producto
  type FoundBlock = { taskId: string; startF: string; totalHoras: number };
  const [ebWorker, setEbWorker] = useState<string>("W1");
  const [ebNombre, setEbNombre] = useState<string>("");
  const [ebMatches, setEbMatches] = useState<FoundBlock[]>([]);
  const [ebSelected, setEbSelected] = useState<string>("");
  const [ebHoras, setEbHoras] = useState<number>(0);
    
// === Botones ===
const btnBase: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  cursor: "pointer",
  userSelect: "none" as const,
  border: "1px solid #d1d5db",
  background: "#fff",
  color: "#111827",
};

const btnAction: React.CSSProperties = {
  ...btnBase,
  height: 38,
  padding: "0 24px",
  fontSize: 14,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 8,
  fontWeight: 500,
};

const btnActionPrimary: React.CSSProperties = {
  ...btnAction,
  background: "#111827",
  color: "#fff",
  border: "1px solid #111827",
};

const btnLabeled: React.CSSProperties = { ...btnBase };
const btnSecondary: React.CSSProperties = { ...btnBase };
const btnDanger: React.CSSProperties = { 
  ...btnBase, 
  border: "1px solid #ef4444", 
  color: "#ef4444", 
  background: "#fff" 
};
const btnPrimary: React.CSSProperties = { ...btnBase, background: "#111827", color: "#fff", border: "1px solid #111827" };
const btnTiny: React.CSSProperties = { padding: "4px 8px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer", fontSize: 12 };
const btnTinyDanger: React.CSSProperties = { ...btnTiny, border: "1px solid #ef4444", color: "#ef4444" };
const btnUnlock: React.CSSProperties = { ...btnBase, background: "#10b981", color: "#fff", border: "1px solid #0ea66d" };
const btnLock: React.CSSProperties   = { ...btnBase, background: "#ef4444", color: "#fff", border: "1px solid #dc2626" };

const deleteBtn: React.CSSProperties = {
  position: "absolute", top: -8, right: -8, background: "#ef4444",
  border: "none", color: "#fff", width: 20, height: 20, borderRadius: "50%",
  cursor: "pointer", lineHeight: "20px", fontSize: 12,
};
const deleteBtnAlt: React.CSSProperties = {
  position: "absolute", top: -8, right: 16, background: "#6b7280",
  border: "none", color: "#fff", width: 22, height: 22, borderRadius: "50%",
  cursor: "pointer", lineHeight: "22px", fontSize: 12,
};
const smallPlusBtn: React.CSSProperties = { background: "#111827", color: "#fff", border: "none", borderRadius: 6, padding: "2px 6px", cursor: "pointer", fontSize: 12 };

const pth: React.CSSProperties = { textAlign: "left", borderBottom: "1px solid #ddd", padding: "6px" };
const ptd: React.CSSProperties = { borderBottom: "1px solid #eee", padding: "6px" };

const sidebar: React.CSSProperties = {
  position: "sticky",
  top: 72,
  alignSelf: "start",
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 10,
  padding: 12,
  maxHeight: "calc(100vh - 90px)",
  overflow: "auto",
};

const miniHint: React.CSSProperties = {
  position: "absolute",
  bottom: 4,
  right: 6,
  background: "rgba(255,255,255,.85)",
  color: "#111827",
  borderRadius: 6,
  padding: "0 4px",
  fontSize: 10,
  fontWeight: 700,
};

const descItem: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 8,
  background: "#fafafa",
};
