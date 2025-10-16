// src/App.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./lib/supabase";
import {
  loadWorkers, upsertWorker, updateWorker,
  loadSlices, insertSlices, updateSlice, deleteSlice,
  loadOverrides, upsertOverride
} from "./lib/db";
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
const PASSWORD = "taller2025"; // <-- cámbiala a la que quieras

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
          <h2>Algo ha fallado 😅</h2>
          <p>La aplicación ha capturado un error y se ha detenido el renderizado de esa parte.</p>
          {this.state.info ? (
            <pre style={{ whiteSpace: "pre-wrap", background: "#f3f4f6", padding: 12, borderRadius: 8 }}>
              {this.state.info}
            </pre>
          ) : null}
          <p style={{ marginTop: 8 }}>Prueba a recargar la página. Si vuelve a pasar, dime el texto del error.</p>
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
  fecha: string;            // YYYY-MM-DD
  horas: number;
  trabajadorId: string;
  color: string;
};

type NewTaskForm = {
  producto: string;
  horasTotales: number;
  trabajadorId: string;
  fechaInicio: string;      // YYYY-MM-DD
};

type OverridesState = Record<string, Record<string, DayOverride>>;
type ProductDescriptions = Record<string, string>;

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

function weekdayShort(d: Date) {
  const m = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"]; // 0=Dom … 6=Sáb
  return m[getDay(d)];
}

function monthGrid(date: Date) {
  const start = startOfWeek(startOfMonth(date), { weekStartsOn: 1 });
  const end = endOfWeek(endOfMonth(date), { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start, end });
  const weeks: Date[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return { start, end, weeks };
}

// Hash genérico
function hashInt(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return Math.abs(h);
}

// Color diferente por BLOQUE (taskId)
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

/* ===================== Replanificación y colas ===================== */
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

function replanWorkerFromDate(
  worker: Worker,
  startF: string,
  overrides: OverridesState,
  allSlices: TaskSlice[]
): TaskSlice[] {
  return compactFrom(worker, startF, overrides, allSlices);
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

// Planificación automática de un bloque (crea taskId y color únicos por bloque)
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
  const color = colorFromId(taskId); // color distinto por BLOQUE
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

/* ===================== App con ErrorBoundary ===================== */
export default function App() {
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
  const [locked, setLocked] = useState(true); // <-- modo bloqueado por defecto
  const canEdit = !locked;

  const [workers, setWorkers] = useState<Worker[]>([
    { id: "W1", nombre: "ANA", extraDefault: 0, sabadoDefault: false },
    { id: "W2", nombre: "ANGEL MORGADO", extraDefault: 0, sabadoDefault: false },
  ]);
  const [nuevoTrabajador, setNuevoTrabajador] = useState("");

  const [overrides, setOverrides] = useState<OverridesState>({});
  const [slices, setSlices] = useState<TaskSlice[]>([]);

  const [descs, setDescs] = useState<ProductDescriptions>({});
  const [descNombre, setDescNombre] = useState("");
  const [descTexto, setDescTexto] = useState("");
  const [editKey, setEditKey] = useState<string | null>(null);

  const [form, setForm] = useState<NewTaskForm>({
    producto: "SAS ALTAN",
    horasTotales: 30,
    trabajadorId: "W2",
    fechaInicio: fmt(new Date()),
  });
// === Cargar datos de Supabase al abrir + Realtime ===
useEffect(() => {
  let active = true;
  (async () => {
    try {
      // Workers
      const w = await loadWorkers();
      if (!active) return;
      if (w.length) {
        setWorkers(w.map(x => ({
          id: x.id,
          nombre: x.nombre,
          extraDefault: x.extra_default,
          sabadoDefault: x.sabado_default,
        })));
      }

      // Slices
      const s = await loadSlices();
      if (!active) return;
      setSlices(s.map(t => ({
        id: t.id,
        taskId: t.task_id,
        producto: t.producto,
        fecha: t.fecha,
        horas: Number(t.horas),
        trabajadorId: t.trabajador_id,
        color: t.color,
      })));

      // Overrides
      const ov = await loadOverrides();
      if (!active) return;
      const map: Record<string, Record<string, { extra: number; sabado: boolean }>> = {};
      for (const o of ov) {
        (map[o.worker_id] ||= {})[o.fecha] = { extra: o.extra, sabado: o.sabado };
      }
      setOverrides(map);

    } catch (e) {
      console.error(e);
      alert("No se pudieron cargar los datos.");
    }
  })();

  // Realtime: refrescar cuando cambie algo en BD
  const ch1 = supabase.channel("rt:task_slices")
    .on("postgres_changes", { event: "*", schema: "public", table: "task_slices" }, async () => {
      const s = await loadSlices();
      if (!active) return;
      setSlices(s.map(t => ({
        id: t.id, taskId: t.task_id, producto: t.producto, fecha: t.fecha,
        horas: Number(t.horas), trabajadorId: t.trabajador_id, color: t.color,
      })));
    })
    .subscribe();

  const ch2 = supabase.channel("rt:workers")
    .on("postgres_changes", { event: "*", schema: "public", table: "workers" }, async () => {
      const w = await loadWorkers();
      if (!active) return;
      setWorkers(w.map(x => ({
        id: x.id, nombre: x.nombre,
        extraDefault: x.extra_default, sabadoDefault: x.sabado_default,
      })));
    })
    .subscribe();

  const ch3 = supabase.channel("rt:day_overrides")
    .on("postgres_changes", { event: "*", schema: "public", table: "day_overrides" }, async () => {
      const ov = await loadOverrides();
      if (!active) return;
      const map: Record<string, Record<string, { extra: number; sabado: boolean }>> = {};
      for (const o of ov) (map[o.worker_id] ||= {})[o.fecha] = { extra: o.extra, sabado: o.sabado };
      setOverrides(map);
    })
    .subscribe();

  return () => {
    active = false;
    try { supabase.removeChannel(ch1); supabase.removeChannel(ch2); supabase.removeChannel(ch3); } catch {}
  };
}, []);

  type PrintMode = "none" | "monthly" | "daily" | "dailyAll";
  const [printMode, setPrintMode] = useState<PrintMode>("none");
  const [printWorker, setPrintWorker] = useState<string>("W1");
  const [printDate, setPrintDate] = useState<string>(fmt(new Date()));
  function triggerPrint(mode: PrintMode) {
    setPrintMode(mode);
    setTimeout(() => window.print(), 100);
    setTimeout(() => setPrintMode("none"), 800);
  }

  // Autenticación simple
  function tryUnlock() {
    const p = prompt("Introduce la contraseña para editar:");
    if (p === PASSWORD) setLocked(false);
    else alert("Contraseña incorrecta");
  }
  function lock() {
    setLocked(true);
  }

  // crear bloque
async function crearBloque() {
  if (!canEdit) return;
  const w = workers.find((x) => x.id === form.trabajadorId);
  if (!w) return;
  const horas = Number(form.horasTotales);
  if (!form.producto.trim() || !isFinite(horas) || horas <= 0) return;

  const start = new Date(form.fechaInicio);
  const plan = planificarBloqueAuto(
    form.producto.trim(),
    horas,
    w,
    start,
    base,
    slices,
    overrides
  );

  // Guardar en BD
  await insertSlices(plan.map(p => ({
    id: p.id,
    task_id: p.taskId,
    producto: p.producto,
    fecha: p.fecha,
    horas: p.horas,
    trabajador_id: p.trabajadorId,
    color: p.color,
  })));

  // Reflejar en pantalla
  setSlices((prev) => [...prev, ...plan]);
}
ices((prev) => [...prev, ...plan]);
  }

  // trabajadores
 async function addWorker() {
  if (!canEdit) return;
  const name = nuevoTrabajador.trim();
  if (!name) return;
  const id = "W" + Math.random().toString(36).slice(2, 6);

  await upsertWorker({ id, nombre: name, extra_default: 0, sabado_default: false });
  setWorkers((prev) => [...prev, { id, nombre: name, extraDefault: 0, sabadoDefault: false }]);
  setNuevoTrabajador("");
}

  async function editWorker(id: string, patch: Partial<Worker>) {
  if (!canEdit) return;

  const dbPatch: any = {};
  if (patch.nombre !== undefined) dbPatch.nombre = patch.nombre;
  if (patch.extraDefault !== undefined) dbPatch.extra_default = patch.extraDefault;
  if (patch.sabadoDefault !== undefined) dbPatch.sabado_default = patch.sabadoDefault;

  await updateWorker(id, dbPatch);
  setWorkers((prev) => prev.map((w) => (w.id === id ? { ...w, ...patch } : w)));
}


  // Drag & Drop
  const dragIdRef = useRef<string | null>(null);
  function onDragStart(e: React.DragEvent, sliceId: string) {
    if (!canEdit) { e.preventDefault(); return; }
    dragIdRef.current = sliceId;
    e.dataTransfer.effectAllowed = "move";
  }
async function onDropDay(e: React.DragEvent, workerId: string, date: Date) {
  if (!canEdit) return;
  e.preventDefault();
  const sliceId = dragIdRef.current;
  dragIdRef.current = null;
  if (!sliceId) return;
  const nuevaFecha = fmt(date);
  if (!nuevaFecha) return;

  // Guardar en BD
  await updateSlice(sliceId, { trabajador_id: workerId, fecha: nuevaFecha });

  // Reflejar en pantalla
  setSlices((prev) =>
    prev.map((s) => (s.id === sliceId ? { ...s, trabajadorId: workerId, fecha: nuevaFecha } : s))
  );
}

  function onDragOver(e: React.DragEvent) {
    if (!canEdit) return;
    e.preventDefault();
  }

  // Doble clic en celda → extras/sábado (reprograma todo ese trabajador desde ese día)
  async function editOverrideForDay(worker: Worker, date: Date) {
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

  // Guardar override en BD
  await upsertOverride({ worker_id: worker.id, fecha: f, extra, sabado: sab });

  // Replanificar desde ese día
  const delTrabajador = slices
    .filter((s) => s.trabajadorId === worker.id)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  const keepBefore = delTrabajador.filter((s) => s.fecha < f);
  const tail = delTrabajador.filter((s) => s.fecha >= f);

  // Overrides en memoria
  const nextOverrides: OverridesState = (() => {
    const byWorker = { ...(overrides[worker.id] || {}) };
    byWorker[f] = { extra, sabado: sab };
    return { ...overrides, [worker.id]: byWorker };
  })();

  const queue = aggregateToQueue(tail);
  const newPlan = reflowFrom(worker, date, nextOverrides, keepBefore, queue);
  const others = slices.filter((s) => s.trabajadorId !== worker.id);
  const finalPlan = [...others, ...newPlan];

  // Persistir cambios en BD
  for (const s of tail) await deleteSlice(s.id);
  await insertSlices(newPlan.map(p => ({
    id: p.id, task_id: p.taskId, producto: p.producto, fecha: p.fecha,
    horas: p.horas, trabajador_id: p.trabajadorId, color: p.color
  })));

  // Actualizar UI
  setOverrides(nextOverrides);
  setSlices(finalPlan);
}


  // Borrar tramo / bloque
 async function removeSlice(id: string) {
  if (!canEdit) return;
  const victim = slices.find((s) => s.id === id);

  // Borrar en BD
  await deleteSlice(id);

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
;
  }

 async function removeTask(taskId: string, workerId: string) {
  if (!canEdit) return;
  if (!confirm("¿Eliminar todo el bloque (producto) para este trabajador?")) return;
  const w = workers.find((x) => x.id === workerId);
  if (!w) return;

  // IDs a borrar en BD
  const toRemoveIds = slices.filter((s) => s.taskId === taskId && s.trabajadorId === workerId).map(s => s.id);
  for (const id of toRemoveIds) await deleteSlice(id);

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
async function addManualHere(worker: Worker, date: Date) {
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
    color: "#eb0d0dff",
    taskId: "T" + Math.random().toString(36).slice(2, 8),
  };

  const queue: QueueItem[] = [urgent, ...aggregateToQueue(tail)];
  const newPlan = reflowFrom(worker, date, overrides, keepBefore, queue);
  const others = slices.filter((s) => s.trabajadorId !== worker.id);
  const finalPlan = [...others, ...newPlan];

  // Persistir cambios: borrar tramos desde 'date' y añadir los nuevos
  const f = fmt(date)!;
  const oldIds = delTrabajador.filter(s => s.fecha >= f).map(s => s.id);
  for (const id of oldIds) await deleteSlice(id);

  const toInsert = newPlan.map(p => ({
    id: p.id, task_id: p.taskId, producto: p.producto, fecha: p.fecha,
    horas: p.horas, trabajador_id: p.trabajadorId, color: p.color,
  }));
  await insertSlices(toInsert);

  setSlices(finalPlan);
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

  function buscarBloques() {
    const w = workers.find((x) => x.id === ebWorker);
    if (!w || !ebNombre.trim()) { setEbMatches([]); setEbSelected(""); setEbHoras(0); return; }

    const delW = slices.filter(s => s.trabajadorId === w.id && s.producto.trim() === ebNombre.trim());
    const byTask = new Map<string, FoundBlock>();
    for (const s of delW) {
      const fb = byTask.get(s.taskId) ?? { taskId: s.taskId, startF: s.fecha, totalHoras: 0 };
      fb.startF = s.fecha < fb.startF ? s.fecha : fb.startF;
      fb.totalHoras = Math.round((fb.totalHoras + s.horas) * 2) / 2;
      byTask.set(s.taskId, fb);
    }
    const arr = [...byTask.values()].sort((a,b)=>a.startF.localeCompare(b.startF));
    setEbMatches(arr);
    if (arr.length) {
      setEbSelected(arr[0].taskId);
      setEbHoras(arr[0].totalHoras);
    } else {
      setEbSelected("");
      setEbHoras(0);
    }
  }

 async function aplicarEdicion() {
  if (!canEdit) return;
  const w = workers.find((x)=>x.id===ebWorker);
  if (!w || !ebSelected) return;
  const match = ebMatches.find(m=>m.taskId===ebSelected);
  if (!match) return;
  const nuevoTotal = Math.max(0.5, Math.round(Number(ebHoras)*2)/2);

  // Quitar lo anterior de ese task/worker desde DB
  const delList = slices.filter(s => s.taskId===ebSelected && s.trabajadorId===w.id);
  for (const s of delList) await deleteSlice(s.id);

  // Replanificar con el mismo taskId y color
  const color = colorFromId(ebSelected);
  const restantes = slices.filter(s => !(s.taskId===ebSelected && s.trabajadorId===w.id));
  const start = new Date(match.startF);
  const plan = planificarBloqueAuto(
    ebNombre.trim(),
    nuevoTotal,
    w,
    start,
    base,
    restantes,
    overrides
  ).map(s=>({...s, taskId: ebSelected, color}));

  // Guardar en BD
  await insertSlices(plan.map(p => ({
    id: p.id, task_id: p.taskId, producto: p.producto, fecha: p.fecha,
    horas: p.horas, trabajador_id: p.trabajadorId, color: p.color
  })));

  // Refrescar vista
  setSlices([...restantes, ...plan]);
}


  /* ===================== Render ===================== */
  return (
    <div style={appShell}>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .print-only { display: block !important; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .worker-block { page-break-inside: avoid; margin-bottom: 16px; }
        }
      `}</style>

      {/* CABECERA SUPERIOR */}
      <header style={topHeader}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h1 style={appTitle}>MONTAJES DELSAZ-PROGRAMACION TALLERES</h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ fontWeight: 700, color: "#fff", marginRight: 8 }}>{monthYear(base)}</div>
          <button style={btnLabeled} onClick={() => setBase(addMonths(base, -1))}>◀ Mes anterior</button>
          <button style={btnLabeled} onClick={() => setBase(addMonths(base, 1))}>Siguiente mes ▶</button>

          {/* Control de bloqueo */}
          {locked ? (
            <button style={btnUnlock} className="no-print" onClick={tryUnlock}>🔒 Desbloquear</button>
          ) : (
            <button style={btnLock} className="no-print" onClick={lock}>🔓 Bloquear</button>
          )}
        </div>
      </header>

      {/* LAYOUT PRINCIPAL */}
      <div style={mainLayout}>
        {/* COLUMNA PRINCIPAL */}
        <div style={{ minWidth: 0 }}>
          {/* BARRA IMPRESIÓN */}
          <div style={bar} className="no-print">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button style={btnLabeled} onClick={() => triggerPrint("monthly")}>🖨️ Imprimir mensual</button>
              <select style={input} value={printWorker} onChange={(e) => setPrintWorker(e.target.value)}>
                {workers.map((w) => <option key={w.id} value={w.id}>{w.nombre}</option>)}
              </select>
              <input style={input} type="date" value={printDate} onChange={(e) => setPrintDate(e.target.value)} />
              <button style={btnLabeled} onClick={() => triggerPrint("daily")}>🖨️ Imprimir diario</button>
              <button style={btnPrimary} onClick={() => triggerPrint("dailyAll")}>🖨️ Imprimir diario (todos)</button>
            </div>
          </div>

          {/* FORM + TRABAJADORES */}
          <div style={panelRow} className="no-print">
            <div style={panel}>
              <div style={panelTitle}>Nuevo bloque</div>

              {/* ---- CENTRADO DEL CONTENIDO ---- */}
              <div style={panelInner}>
                <div style={grid2}>
                  <label style={label}>Producto</label>
                  <input style={disabledIf(input, locked)} disabled={locked} value={form.producto} onChange={(e) => setForm({ ...form, producto: e.target.value })} />
                  <label style={label}>Horas totales</label>
                  <input
                    style={disabledIf(input, locked)}
                    disabled={locked}
                    type="number"
                    min={0.5}
                    step={0.5}
                    value={form.horasTotales}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setForm({ ...form, horasTotales: isFinite(v) ? v : 0 });
                    }}
                  />
                  <label style={label}>Trabajador</label>
                  <select style={disabledIf(input, locked)} disabled={locked} value={form.trabajadorId} onChange={(e) => setForm({ ...form, trabajadorId: e.target.value })}>
                    {workers.map((w) => <option key={w.id} value={w.id}>{w.nombre}</option>)}
                  </select>
                  <label style={label}>Fecha inicio</label>
                  <input
                    style={disabledIf(input, locked)}
                    disabled={locked}
                    type="date"
                    value={form.fechaInicio}
                    onChange={(e) => setForm({ ...form, fechaInicio: e.target.value })}
                  />
                </div>
                <div style={{ marginTop: 12, display: "flex", justifyContent: "center" }}>
                  <button style={disabledIf(btnPrimary, locked)} disabled={locked} onClick={crearBloque}>➕ Planificar</button>
                </div>
              </div>
            </div>

            <div style={panel}>
              <div style={panelTitle}>Trabajadores</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <input style={disabledIf(input, locked)} disabled={locked} placeholder="Nombre del trabajador" value={nuevoTrabajador} onChange={(e) => setNuevoTrabajador(e.target.value)} />
                <button style={disabledIf(btnLabeled, locked)} disabled={locked} onClick={addWorker}>➕ Añadir</button>
              </div>
              <table style={table}>
                <thead>
                  <tr>
                    <th style={th}>Nombre</th>
                    <th style={th}>Extra por defecto (L–V)</th>
                    <th style={th}>Sábado por defecto</th>
                  </tr>
                </thead>
                <tbody>
                  {workers.map((w) => (
                    <tr key={w.id}>
                      <td style={td}><input style={disabledIf(input, locked)} disabled={locked} value={w.nombre} onChange={(e) => editWorker(w.id, { nombre: e.target.value })} /></td>
                      <td style={td}><input style={disabledIf(input, locked)} disabled={locked} type="number" min={0} step={0.5} value={w.extraDefault} onChange={(e) => editWorker(w.id, { extraDefault: Number(e.target.value) })} /></td>
                      <td style={td}><input disabled={locked} type="checkbox" checked={w.sabadoDefault} onChange={(e) => editWorker(w.id, { sabadoDefault: e.target.checked })} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>
                {locked ? "Bloqueado: solo lectura." :
                <>Doble clic en una <b>celda</b> para fijar <b>extras/sábado</b> de ese <b>día</b>. Botón <b>＋</b> inserta un bloque desde ese día.</>}
              </div>
            </div>
          </div>

          {/* CABECERA DÍAS (impresión mensual) */}
          <div style={daysHeader} className={printMode === "monthly" ? "" : "no-print"}>
            {weekDaysHeader.map((d) => (
              <div key={d} style={{ padding: "6px 8px", fontWeight: 600 }}>{d}</div>
            ))}
          </div>

          {/* CALENDARIO */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }} className={printMode === "monthly" ? "" : "no-print"}>
            {workers.map((w) => (
              <div key={w.id}>
                <div style={{ fontSize: 25, fontWeight: 700, margin: "8px 0 4px", color: "#111827" }}>👤 {w.nombre}</div>

                {weeks.map((week, i) => (
                  <div key={`${w.id}-wk-${i}`} style={weekRow}>
                    {week.map((d) => {
                      const f = fmt(d);
                      const delDia = f ? slices.filter((s) => s.trabajadorId === w.id && s.fecha === f) : [];
                      const cap = capacidadDia(w, d, overrides);
                      const used = usadasEnDia(slices, w.id, d);
                      const ow = f ? overrides[w.id]?.[f] : undefined;

                      return (
                        <div
                          key={`${w.id}-${f || i}`}
                          style={dayCell}
                          title={`Doble clic: extras/sábado para ${w.nombre} el ${f || "día"}`}
                          onDoubleClick={() => canEdit && editOverrideForDay(w, d)}
                          onDragOver={onDragOver}
                          onDrop={(e) => onDropDay(e, w.id, d)}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div style={dayLabel}>
                              {format(d, "d")} <span style={{ color: "#111827" }}>{weekdayShort(d)}</span>{" "}
                              {ow ? (
                                <span style={{ fontSize: 12, color: "#d81327f0" }}>
                                  {getDay(d) !== 6 && ow.extra ? `+${ow.extra}horas extra ` : ""}
                                  {getDay(d) === 6 && ow.sabado ? "Sáb ON" : ""}
                                </span>
                              ) : null}
                            </div>
                            {canEdit && (
                              <button className="no-print" onClick={() => addManualHere(w, d)} style={smallPlusBtn} title="Insertar manual aquí">＋</button>
                            )}
                          </div>

                          <div style={horizontalLane}>
                            {delDia.map((s) => {
                              const desc = descs[s.producto];
                              return (
                                <div
                                  key={s.id}
                                  draggable={canEdit}
                                  onDragStart={(e) => onDragStart(e, s.id)}
                                  title={`${s.producto} — ${s.horas}h${desc ? "\n" + desc : ""}`}
                                  style={{
                                    ...blockStyle,
                                    background: s.color,
                                    width: Math.max(18, s.horas * PX_PER_HOUR),
                                    position: "relative",
                                  }}
                                >
                                  {canEdit && (
                                    <>
                                      <button onClick={(e) => { e.stopPropagation(); removeSlice(s.id); }} title="Eliminar tramo" style={deleteBtn}>✖</button>
                                      <button onClick={(e) => { e.stopPropagation(); removeTask(s.taskId, s.trabajadorId); }} title="Eliminar bloque completo" style={deleteBtnAlt}>🗑</button>
                                    </>
                                  )}

                                  <div style={blockTop}>
                                    <span style={productFull}>{s.producto}</span>
                                    <span>{s.horas}h</span>
                                  </div>
                                  {desc ? <div style={miniHint}>ⓘ</div> : null}
                                </div>
                              );
                            })}
                          </div>

                          <DayCapacityBadge capacidad={cap} usado={used} />
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Parte diario — individual (solo impresión) */}
          {printMode === "daily" && (
            <div className="print-only">
              {(() => {
                const w = workers.find((x) => x.id === printWorker);
                if (!w) return null;
                const d = new Date(printDate);
                const valid = !isNaN(d.getTime?.() ?? NaN);
                const f = valid ? fmt(d) : "";
                const daySlices = valid ? slices.filter((s) => s.trabajadorId === w.id && s.fecha === f) : [];
                const cap = valid ? capacidadDia(w, d, overrides) : 0;
                const used = valid ? usadasEnDia(slices, w.id, d) : 0;
                return (
                  <div className="worker-block" style={{ marginTop: 8 }}>
                    <h2 style={{ margin: 0 }}>
                      Parte diario — {w.nombre} — {valid ? format(d, "EEEE d 'de' LLLL yyyy", { locale: es }) : "fecha inválida"}
                    </h2>
                    <p>Capacidad: {cap}h · Asignado: {used}h · Libre: {(cap - used).toFixed(1)}h</p>
                    <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12 }}>
                      <thead>
                        <tr><th style={pth}>Producto</th><th style={pth}>Horas</th><th style={pth}>Descripción</th></tr>
                      </thead>
                      <tbody>
                        {daySlices.length ? daySlices.map((s) => (
                          <tr key={s.id}>
                            <td style={ptd}>{s.producto}</td>
                            <td style={ptd}>&nbsp;{s.horas}</td>
                            <td style={ptd}>{descs[s.producto] || ""}</td>
                          </tr>
                        )) : <tr><td style={ptd} colSpan={3}>Sin asignaciones.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>
          )}

          {/* Parte diario — TODOS los trabajadores (solo impresión) */}
          {printMode === "dailyAll" && (
            <div className="print-only" style={{ marginTop: 8 }}>
              {(() => {
                const d = new Date(printDate);
                const valid = !isNaN(d.getTime?.() ?? NaN);
                const f = valid ? fmt(d) : "";
                return (
                  <>
                    {workers.map((w) => {
                      const daySlices = valid ? slices.filter((s) => s.trabajadorId === w.id && s.fecha === f) : [];
                      const cap = valid ? capacidadDia(w, d, overrides) : 0;
                      const used = valid ? usadasEnDia(slices, w.id, d) : 0;
                      return (
                        <div key={w.id} className="worker-block">
                          <h2 style={{ margin: 0 }}>
                            Parte diario — {w.nombre} — {valid ? format(d, "EEEE d 'de' LLLL yyyy", { locale: es }) : "fecha inválida"}
                          </h2>
                          <p>Capacidad: {cap}h · Asignado: {used}h · Libre: {(cap - used).toFixed(1)}h</p>
                          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12 }}>
                            <thead>
                              <tr><th style={pth}>Producto</th><th style={pth}>Horas</th><th style={pth}>Descripción</th></tr>
                            </thead>
                            <tbody>
                              {daySlices.length ? daySlices.map((s) => (
                                <tr key={s.id}>
                                  <td style={ptd}>{s.producto}</td>
                                  <td style={ptd}>&nbsp;{s.horas}</td>
                                  <td style={ptd}>{descs[s.producto] || ""}</td>
                                </tr>
                              )) : <tr><td style={ptd} colSpan={3}>Sin asignaciones.</td></tr>}
                            </tbody>
                          </table>
                          <div style={{ marginTop: 24, display: "flex", gap: 40 }}>
                            <div>Firma trabajador: ____________________________</div>
                            <div>Firma responsable: __________________________</div>
                          </div>
                        </div>
                      );
                    })}
                  </>
                );
              })()}
            </div>
          )}
        </div>

        {/* SIDEBAR */}
        <aside style={sidebar} className="no-print">
          <div style={panelTitle}>Descripciones de productos</div>

          <div style={{ display: "grid", gap: 8 }}>
            <input
              style={disabledIf(input, locked)}
              disabled={locked}
              placeholder="Nombre de producto (coincidirá con el bloque)"
              value={descNombre}
              onChange={(e) => setDescNombre(e.target.value)}
            />
            <textarea
              style={disabledIf(textarea, locked)}
              disabled={locked}
              placeholder="Descripción / instrucciones para el trabajador"
              rows={6}
              value={descTexto}
              onChange={(e) => setDescTexto(e.target.value)}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button style={disabledIf(btnPrimary, locked)} disabled={locked} onClick={saveDesc}>{editKey ? "💾 Guardar cambios" : "➕ Añadir"}</button>
              {editKey && (
                <button style={disabledIf(btnLabeled, locked)} disabled={locked} onClick={() => { setEditKey(null); setDescNombre(""); setDescTexto(""); }}>
                  Cancelar
                </button>
              )}
            </div>
          </div>

          <div style={{ marginTop: 12, fontWeight: 700 }}>Listado</div>
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
            {Object.keys(descs).length === 0 && (
              <div style={{ color: "#6b7280", fontSize: 13 }}>No hay descripciones todavía.</div>
            )}
            {Object.entries(descs).map(([prod, texto]) => (
              <div key={prod} style={descItem}>
                <div style={{ fontWeight: 700 }}>{prod}</div>
                <div style={{ fontSize: 12, color: "#374151", whiteSpace: "pre-wrap" }}>{texto}</div>
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <button style={disabledIf(btnTiny, locked)} disabled={locked} onClick={() => editDesc(prod)}>✏️ Editar</button>
                  <button style={disabledIf(btnTinyDanger, locked)} disabled={locked} onClick={() => deleteDesc(prod)}>🗑 Eliminar</button>
                </div>
              </div>
            ))}
          </div>

          {/* Editor de bloques por producto */}
          <div style={{ ...panel, marginTop: 14 }}>
            <div style={panelTitle}>Editar bloque por producto</div>
            <div style={{ display: "grid", gap: 8 }}>
              <label style={label}>Trabajador</label>
              <select style={disabledIf(input, locked)} disabled={locked} value={ebWorker} onChange={e=>setEbWorker(e.target.value)}>
                {workers.map(w=><option key={w.id} value={w.id}>{w.nombre}</option>)}
              </select>

              <label style={label}>Producto</label>
              <input style={disabledIf(input, locked)} disabled={locked} placeholder="Nombre exacto del producto" value={ebNombre} onChange={e=>setEbNombre(e.target.value)} />

              <div style={{ display:"flex", gap:8 }}>
                <button style={disabledIf(btnLabeled, locked)} disabled={locked} onClick={buscarBloques}>🔎 Buscar</button>
              </div>

              {ebMatches.length>0 ? (
                <>
                  <label style={label}>Bloque encontrado</label>
                  <select style={disabledIf(input, locked)} disabled={locked} value={ebSelected} onChange={e=>{
                    const id=e.target.value; setEbSelected(id);
                    const m = ebMatches.find(x=>x.taskId===id);
                    if (m) setEbHoras(m.totalHoras);
                  }}>
                    {ebMatches.map(m=>(
                      <option key={m.taskId} value={m.taskId}>
                        {m.startF} · {m.totalHoras}h · {ebNombre}
                      </option>
                    ))}
                  </select>

                  <label style={label}>Horas totales (nuevo)</label>
                  <input style={disabledIf(input, locked)} disabled={locked} type="number" step={0.5} min={0.5} value={ebHoras} onChange={e=>setEbHoras(Number(e.target.value))} />

                  <button style={disabledIf(btnPrimary, locked)} disabled={locked} onClick={aplicarEdicion}>💾 Actualizar bloque</button>
                </>
              ) : (
                <div style={{ fontSize:12, color:"#6b7280" }}>Introduce trabajador y producto, pulsa <b>Buscar</b>.</div>
              )}
            </div>
          </div>

          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 12 }}>
            Consejo: el <b>nombre del producto</b> debe coincidir exactamente para localizar el bloque.
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ===================== Helpers de estilo ===================== */
function disabledIf<T extends React.CSSProperties>(style: T, disabled: boolean): T {
  return (disabled
    ? { ...style, opacity: 0.6, cursor: "not-allowed" }
    : style) as T;
}

/* ===================== Badge ===================== */
function DayCapacityBadge({ capacidad, usado }: { capacidad: number; usado: number }) {
  const libre = Math.max(0, Math.round((capacidad - usado) * 10) / 10);
  return (
    <div style={{ marginTop: 6, fontSize: 11, color: "#374151" }}>
      Cap: {capacidad.toFixed(1)}h · Usado: {usado.toFixed(1)}h · Libre: <span style={{ fontWeight: 700 }}>{libre.toFixed(1)}h</span>
    </div>
  );
}

/* ===================== Estilos ===================== */
const appShell: React.CSSProperties = {
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  background: "#c6f5f9ff", // Azul sólido
  minHeight: "100vh",
};

const topHeader: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 50,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 16px",
  background: "#3218d6",
  borderBottom: "1px solid rgba(255,255,255,.25)",
};

const appTitle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 900,
  letterSpacing: 0.4,
  margin: 0,
  textTransform: "uppercase",
  color: "#ffffff",
};

const mainLayout: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 360px",
  gap: 12,
  padding: 16,
  alignItems: "start",
};

const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 12,
};

const panelRow: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 12,
  marginBottom: 12,
};

const panel: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 10,
  padding: 12,
  background: "#fff",
};

const panelInner: React.CSSProperties = {
  width: "100%",
  maxWidth: "640px",
  margin: "0 auto",
  padding: "0 8px",
  boxSizing: "border-box",
};


const panelTitle: React.CSSProperties = { fontWeight: 700, marginBottom: 8, color: "#111827" };
const grid2: React.CSSProperties = { display: "grid", gap: 8, gridTemplateColumns: "180px 1fr", alignItems: "center" };
const label: React.CSSProperties = { fontSize: 13, color: "#374151" };
const input: React.CSSProperties = { padding: "8px 10px", border: "1px solid #e5e7eb", borderRadius: 8, outline: "none", width: "100%", boxSizing: "border-box",};
const textarea: React.CSSProperties = { ...input, minHeight: 100, resize: "vertical" as const };

const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 13, background: "#fff" };
const th: React.CSSProperties = { textAlign: "left", borderBottom: "1px solid #e5e7eb", padding: "6px", background: "#f9fafb" };
const td: React.CSSProperties = { borderBottom: "1px solid #f3f4f6", padding: "6px" };

const daysHeader: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(7, 1fr)",
  gap: 2,
  fontSize: 12,
  margin: "8px 0 4px",
  color: "#000000ff",
};

const weekRow: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 2 };
const dayCell: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  minHeight: 130,
  padding: 6,
  display: "flex",
  flexDirection: "column",
  background: "#fafafa",
  borderRadius: 8,
};
const dayLabel: React.CSSProperties = { fontSize: 11, color: "#6b7280" };

const horizontalLane: React.CSSProperties = { display: "flex", gap: 6, overflowX: "auto", alignItems: "flex-start" };
const blockStyle: React.CSSProperties = {
  color: "#fff",
  borderRadius: 8,
  padding: "6px 8px",
  fontSize: 12,
  minHeight: 34,
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  cursor: "grab",
  boxShadow: "0 1px 2px rgba(0,0,0,.15)",
};
const blockTop: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" };

const productFull: React.CSSProperties = {
  fontWeight: 700,
  whiteSpace: "normal",
  overflow: "visible",
  textOverflow: "clip",
  wordBreak: "break-word",
  lineHeight: 1.1,
  marginRight: 8,
  maxWidth: "100%",
};

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
const btnLabeled: React.CSSProperties = { ...btnBase };
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
