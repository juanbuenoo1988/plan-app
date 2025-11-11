// src/Planificador.tsx
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import React, { useEffect, useMemo, useRef, useState } from "react";
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
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";

/* ===================== Configuración ===================== */
const PASSWORD = "0000"; // ← cámbiala por la que quieras
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

// Estado de la conexión Realtime
type RTStatus = "connecting" | "connected" | "error";


type Worker = {
  id: string;
  nombre: string;
  jornada: {
    lu: number; // lunes
    ma: number; // martes
    mi: number; // miércoles
    ju: number; // jueves
    vi: number; // viernes
  };
};

// === Tipos para sobrescrituras por día (por trabajador) ===
type DayOverride = {
  extra?: number;
  sabado?: boolean;
  domingo?: boolean;
  vacacion?: boolean;
};

type OverridesState = {
  [workerId: string]: {
    [iso: string]: DayOverride;
  };
};


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

// --- FORMATEO LOCAL, sin UTC ---
const toLocalISO = (d: Date) => format(d, "yyyy-MM-dd");

// Construye un Date a medianoche local desde "YYYY-MM-DD"
const fromLocalISO = (iso: string) => {
  const [y, m, dd] = iso.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, dd ?? 1); // ← SIN UTC
};

const weekDaysHeader = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
const PX_PER_HOUR = 20;
const URGENT_COLOR = "#f59e0b";

const isUrgentSlice = (s: TaskSlice) =>
  s.color === URGENT_COLOR ||
  /^⚠️/.test(s.producto) ||
  /urgenc/i.test(s.producto);


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

// Capacidad real del día para un trabajador, teniendo en cuenta overrides
const WEEKEND_BASE_HOURS = 8; // cuando se habilita sábado/domingo

function capacidadDia(w: Worker, d: Date, ov: OverridesState): number {
  const iso = toLocalISO(d as Date);
  const dow = getDay(d); // 0=domingo, 1=lunes,...,6=sábado
  const byW = ov[w.id] || {};
  const o: DayOverride = byW[iso] || {};

  // Vacaciones = 0
  if (o.vacacion) return 0;

  // ¿Es laborable?
  let esLaborable = false;
  if (dow >= 1 && dow <= 5) esLaborable = true;          // L–V siempre
  else if (dow === 6) esLaborable = !!o.sabado;          // sábado si override
  else if (dow === 0) esLaborable = !!o.domingo;         // domingo si override
  if (!esLaborable) return 0;

  // Base según jornada del trabajador (L–V) o fin de semana
  let base =
    dow === 1 ? w.jornada.lu :
    dow === 2 ? w.jornada.ma :
    dow === 3 ? w.jornada.mi :
    dow === 4 ? w.jornada.ju :
    dow === 5 ? w.jornada.vi :
    WEEKEND_BASE_HOURS;

  // Extra del override (solo lo sumamos; ya no existe “extra por defecto”)
  const extra = Number(o.extra ?? 0);

  return Math.max(0, Math.round((base + extra) * 2) / 2);
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
  // 1) Partes del trabajador ANTES de startF (se conservan)
  const keepBefore = allSlices
    .filter((s) => s.trabajadorId === worker.id && s.fecha < startF)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  // 2) Partes del trabajador DESDE startF (se reempacan)
  const fromHere = allSlices
    .filter((s) => s.trabajadorId === worker.id && s.fecha >= startF)
    .sort((a, b) =>
      a.fecha < b.fecha ? -1 :
      a.fecha > b.fecha ?  1 :
      (a.id   < b.id   ? -1 : a.id > b.id ? 1 : 0)
    );

  // 3) Separar URGENTES (no se mueven de su día) y movibles
  const pinned  = fromHere.filter(isUrgentSlice);
  const movable = fromHere.filter((s) => !isUrgentSlice(s));

  // 4) Cola agregada por bloque (sólo lo movible)
  const queue = aggregateToQueue(movable);

  // 5) Reconstrucción día a día dejando primero URGENCIAS fijas
  const rebuilt: TaskSlice[] = [];
  let dayISO = startF;
  let guard = 0;
  while ((queue.length > 0 || pinned.length > 0) && guard < 365) {
    guard++;

    let capLeft = Math.max(0, capacidadDia(worker, fromLocalISO(dayISO), overrides));

    // URGENCIAS de este día (no se tocan)
    const todaysPinned = pinned.filter((p) => p.fecha === dayISO);
    for (const p of todaysPinned) {
      rebuilt.push({ ...p });
      capLeft = Math.max(0, Math.round((capLeft - p.horas) * 2) / 2);
    }

    // Rellenar con la cola movible
    while (queue.length > 0 && capLeft > 1e-9) {
      const head = queue[0];
      const take = Math.min(head.horas, capLeft);
      if (take > 1e-9) {
        rebuilt.push({
          id: (crypto as any)?.randomUUID
  ? (crypto as any).randomUUID()
  : "S" + Math.random().toString(36).slice(2, 10),
          taskId: head.taskId,
          producto: head.producto,
          fecha: dayISO,
          horas: Math.round(take * 2) / 2,
          trabajadorId: worker.id,
          color: head.color,
        });
        head.horas = Math.round((head.horas - take) * 2) / 2;
        capLeft    = Math.round((capLeft    - take) * 2) / 2;
      }
      if (head.horas <= 1e-9) queue.shift();
    }

    dayISO = toLocalISO(addDays(fromLocalISO(dayISO), 1));
  }

  // 6) Devuelve SOLO lo del trabajador (antes + reconstruido)
  return [...keepBefore, ...rebuilt];
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
  { id: "W1", nombre: "ANGEL MORGADO",  jornada: { lu: 8.5, ma: 8.5, mi: 8.5, ju: 8.5, vi: 6 } },
  { id: "W2", nombre: "ANTONIO MONTILLA", jornada: { lu: 8.5, ma: 8.5, mi: 8.5, ju: 8.5, vi: 6 } },
  { id: "W3", nombre: "DANIEL MORGADO", jornada: { lu: 8.5, ma: 8.5, mi: 8.5, ju: 8.5, vi: 6 } },
  { id: "W4", nombre: "FIDEL RODRIGO",   jornada: { lu: 8.5, ma: 8.5, mi: 8.5, ju: 8.5, vi: 6 } },
  { id: "W5", nombre: "LUCAS PRIETO",    jornada: { lu: 8.5, ma: 8.5, mi: 8.5, ju: 8.5, vi: 6 } },
  { id: "W6", nombre: "LUIS AGUADO",     jornada: { lu: 8.5, ma: 8.5, mi: 8.5, ju: 8.5, vi: 6 } },
  { id: "W7", nombre: "VICTOR HERNANDEZ", jornada: { lu: 8.5, ma: 8.5, mi: 8.5, ju: 8.5, vi: 6 } },
  ]);
  const [nuevoTrabajador, setNuevoTrabajador] = useState("");

  const [overrides, setOverrides] = useState<OverridesState>({});
  const [slices, setSlices] = useState<TaskSlice[]>([]);

  const [descs, setDescs] = useState<ProductDescriptions>({});
  const [descNombre, setDescNombre] = useState("");
  const [descTexto, setDescTexto] = useState("");
  const [editKey, setEditKey] = useState<string | null>(null);
  // === Estado panel Gestión masiva ===
const [gmWorker, setGmWorker] = useState<string>(() => workers[0]?.id || "");
const [gmFrom, setGmFrom] = useState<string>(() => new Date().toISOString().slice(0,10));
const [gmTo, setGmTo] = useState<string>(() => new Date().toISOString().slice(0,10));
const [gmExtra, setGmExtra] = useState<number>(0);

  // === Estado para "Actualizar día trabajador"
const [updOpen, setUpdOpen] = useState(false);
const [updWorker, setUpdWorker] = useState<string>(workers[0]?.id ?? "");
const [updDate, setUpdDate] = useState<string>(() => {
  const d = new Date();
  return dayKeyOf(d);
});

// Para añadir incidencias desde el panel
const [updNewProd, setUpdNewProd] = useState("");
const [updNewHoras, setUpdNewHoras] = useState<number>(1);
const [rtStatus, setRtStatus] = useState<RTStatus>("connecting");


// Derivados: bloques del día seleccionado
const updMatches = useMemo(() => {
  if (!updWorker || !updDate) return [];
  return slices
    .filter(s => s.trabajadorId === updWorker && s.fecha === updDate)
    // Conviene agrupar por taskId si un mismo producto se parte en varias barras el mismo día.
    .map(s => ({
      taskId: s.taskId,
      producto: s.producto,
      horasHoy: s.horas
    }));
}, [slices, updWorker, updDate]);

  const [form, setForm] = useState<NewTaskForm>({
    producto: "",
    horasTotales: 0,
    trabajadorId: "W1",
    fechaInicio: fmt(new Date()),
  });
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
  const hydratedRef = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const lastSavedRef = useRef<string>("");

  type PrintMode = "none" | "monthly" | "daily" | "dailyAll";
  const [printMode, setPrintMode] = useState<PrintMode>("none");
  const [isNewBlockOpen, setIsNewBlockOpen] = useState(true);
const [isWorkersOpen, setIsWorkersOpen] = useState(false);
  const [printWorker, setPrintWorker] = useState<string>("W1");
  const [printDate, setPrintDate] = useState<string>(fmt(new Date()));

  const saveEpoch = useRef(0);
  // === Realtime helpers ===
const applyingRemoteRef = useRef(false);       // marca: estoy aplicando un cambio que vino del servidor
const rafFlushRef = useRef<number | null>(null); // para liberar la marca en el siguiente frame

function applyRemote(run: () => void) {
  applyingRemoteRef.current = true;
  run();
  if (rafFlushRef.current) cancelAnimationFrame(rafFlushRef.current);
  rafFlushRef.current = requestAnimationFrame(() => {
    applyingRemoteRef.current = false;
    rafFlushRef.current = null;
  });
}


  // === Copias de seguridad (localStorage)
const BACKUP_INDEX_KEY = "planner:backup:index";
const MAX_BACKUPS = 100; // número máximo de copias locales que se guardan

type PlannerSnapshot = {
  version: 1;
  ts: number; // fecha y hora de la copia
  workers: typeof workers;
  slices: typeof slices;
  overrides: typeof overrides;
  descs: typeof descs;
};


  // 🔽🔽🔽 Pega aquí todo este bloque completo 🔽🔽🔽

  function flattenOverrides(ov: OverridesState) {
    type OverrideRow = {
  worker_id: string;
  fecha: string;
  extra: number;
  sabado: boolean;
  domingo: boolean;   // ⬅️ nuevo
  vacacion: boolean;  // ⬅️ nuevo
};

const rows: OverrideRow[] = [];
    Object.entries(ov).forEach(([workerId, byDate]) => {
      Object.entries(byDate).forEach(([fecha, v]) => {
        rows.push({ worker_id: workerId,
    fecha,
    extra: Number(v.extra ?? 0),
    sabado: !!v.sabado,
    domingo: !!v.domingo, 
    vacacion: !!v.vacacion, });
      });
    });
    return rows;
  }

function editBlockTotalFromSlice(slice: TaskSlice) {
  if (!canEdit) return;

  const w = workers.find(x => x.id === slice.trabajadorId);
  if (!w) return;

  // Todas las partes de ese bloque (taskId) para ese trabajador
  const delBloque = slices.filter(s => s.trabajadorId === w.id && s.taskId === slice.taskId);
  if (delBloque.length === 0) return;

  // Primer día del bloque y total actual
  const startF = delBloque.reduce((m, s) => (s.fecha < m ? s.fecha : m), delBloque[0].fecha);
  const totalActual = Math.round(delBloque.reduce((a, s) => a + s.horas, 0) * 2) / 2;

  // Pedimos nuevo total
  const nuevoStr = prompt(
    `Horas totales para "${slice.producto}" (${w.nombre}) desde ${startF}:`,
    String(totalActual)
  );
  if (nuevoStr === null) return;

  const nuevoTotal = Math.max(0.5, Math.round(Number(nuevoStr) * 2) / 2);
  if (!isFinite(nuevoTotal) || nuevoTotal <= 0) return;

  // Parser robusto YYYY-MM-DD → fecha local (evita desfaces de huso horario)
  const fromLocalISO = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, (m ?? 1) - 1, d ?? 1);
  };

  setSlices(prev => {
    // 1) Elimina el bloque antiguo de ese trabajador
    const restantes = prev.filter(s => !(s.taskId === slice.taskId && s.trabajadorId === w.id));

    // 2) Replanifica SOLO ese bloque desde su primer día
    const plan = planificarBloqueAuto(
      slice.producto,
      nuevoTotal,
      w,
      fromLocalISO(startF), // ← fecha local segura
      base,                 // tu estado "base" es Date, como en el antiguo
      restantes,            // MUY IMPORTANTE: planificamos contra el snapshot
      overrides
    ).map(s => ({ ...s, taskId: slice.taskId, color: colorFromId(slice.taskId) }));

    // 3) Mezcla (resto + plan nuevo)
    const merged = [...restantes, ...plan];

    // 4) (Opcional pero recomendado) Compacta TODO ese trabajador desde startF,
    //    usando SOLO el snapshot "merged" (nada de setTimeout ni setState fuera).
    const reflowedForWorker = compactFrom(w, startF, overrides, merged);
    const others = merged.filter(s => s.trabajadorId !== w.id);

    // 5) Devolvemos el resultado final en un ÚNICO setState
    return [...others, ...reflowedForWorker];
  });
}

function editUrgentSlice(slice: TaskSlice) {
  const nuevoStr = prompt(
    `Horas reales para "${slice.producto}" el ${slice.fecha}:`,
    String(slice.horas)
  );
  if (nuevoStr === null) return;

  const h = Math.max(0.5, Math.round(Number(nuevoStr) * 2) / 2);
  if (!isFinite(h)) return;

  const w = workers.find(x => x.id === slice.trabajadorId);
  if (!w) return;

  setSlices(prev => {
    // 1) fija SOLO ese tramo (amarillo)
    const fixed = prev.map(s =>
      s.id === slice.id ? { ...s, horas: h, color: URGENT_COLOR } : s
    );

    // 2) re-empaqueta desde ese día manteniendo urgencias clavadas
    const reflowedForWorker = compactFrom(w, slice.fecha, overrides, fixed);
    const others = fixed.filter(s => s.trabajadorId !== w.id);
    return [...others, ...reflowedForWorker];
  });
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
  { user_id: uid, id: "W1", nombre: "ANGEL MORGADO",  lu_hours: 8.5, ma_hours: 8.5, mi_hours: 8.5, ju_hours: 8.5, vi_hours: 6, tenant_id: TENANT_ID },
  { user_id: uid, id: "W2", nombre: "ANTONIO MONTILLA", lu_hours: 8.5, ma_hours: 8.5, mi_hours: 8.5, ju_hours: 8.5, vi_hours: 6, tenant_id: TENANT_ID },
  { user_id: uid, id: "W3", nombre: "DANIEL MORGADO",  lu_hours: 8.5, ma_hours: 8.5, mi_hours: 8.5, ju_hours: 8.5, vi_hours: 6, tenant_id: TENANT_ID },
  { user_id: uid, id: "W4", nombre: "FIDEL RODRIGO",   lu_hours: 8.5, ma_hours: 8.5, mi_hours: 8.5, ju_hours: 8.5, vi_hours: 6, tenant_id: TENANT_ID },
  { user_id: uid, id: "W5", nombre: "LUCAS PRIETO",    lu_hours: 8.5, ma_hours: 8.5, mi_hours: 8.5, ju_hours: 8.5, vi_hours: 6, tenant_id: TENANT_ID },
  { user_id: uid, id: "W6", nombre: "LUIS AGUADO",     lu_hours: 8.5, ma_hours: 8.5, mi_hours: 8.5, ju_hours: 8.5, vi_hours: 6, tenant_id: TENANT_ID },
  { user_id: uid, id: "W7", nombre: "VICTOR HERNANDEZ",lu_hours: 8.5, ma_hours: 8.5, mi_hours: 8.5, ju_hours: 8.5, vi_hours: 6, tenant_id: TENANT_ID },
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

      if (Array.isArray(wData) && wData.length > 0) {
  setWorkers(
    wData.map((r: any) => ({
      id: r.id,
      nombre: r.nombre,
      jornada: {
        lu: Number(r.lu_hours ?? 8.5),
        ma: Number(r.ma_hours ?? 8.5),
        mi: Number(r.mi_hours ?? 8.5),
        ju: Number(r.ju_hours ?? 8.5),
        vi: Number(r.vi_hours ?? 6),
      },
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
        const obj: Record<string, Record<string, { extra?: number; sabado?: boolean; domingo?: boolean; vacacion?: boolean }>> = {};
for (const r of oData as any[]) {
  if (!obj[r.worker_id]) obj[r.worker_id] = {};
  obj[r.worker_id][r.fecha] = {
    extra: Number(r.extra ?? 0),
    sabado: !!r.sabado,
    domingo: !!r.domingo,    // ⬅️ nuevo
    vacacion: !!r.vacacion,  // ⬅️ nuevo
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


 async function ensureSessionOrExplain(): Promise<boolean> {
  // 1) Conectividad
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    setSaveError("Sin conexión. No se puede guardar.");
    return false;
  }
  // 2) Sesión válida
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    setSaveError("Sesión caducada. Inicia sesión para seguir guardando.");
    setAuthMsg("Sesión caducada. Introduce tu email y pulsa «Enviarme enlace».");
    return false;
  }
  // 3) (Opcional) Si al token le queda <60s, deja que Supabase lo refresque
  const exp = session.expires_at ? session.expires_at * 1000 : 0;
  if (exp && exp - Date.now() < 60_000) {
    const { data, error } = await supabase.auth.getSession(); // refresca solo
    if (error || !data.session) {
      setSaveError("No se pudo refrescar la sesión. Vuelve a entrar.");
      return false;
    }
  }
  return true;
}


  /**
 * Guarda TODO el estado en Supabase de forma segura:
 * 1) UPSERT (nunca nos quedamos a cero si falla algo)
 * 2) Borra solo lo que sobra (selectivo)
 */
async function saveAll(uid: string) {
  // --- 0) Preparar filas con tenant_id y user_id ---
  const wRows = workers.map(w => ({
  id: w.id,
  nombre: w.nombre,
  lu_hours: w.jornada.lu,
  ma_hours: w.jornada.ma,
  mi_hours: w.jornada.mi,
  ju_hours: w.jornada.ju,
  vi_hours: w.jornada.vi,
  user_id: uid,
  tenant_id: TENANT_ID,
  updated_by: uid,  
}));

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
    updated_by: uid, 
  }));

  const oRows = flattenOverrides(overrides).map((r) => ({
  worker_id: r.worker_id,
  fecha: r.fecha,
  extra: r.extra ?? 0,
  sabado: !!r.sabado,
  domingo: !!r.domingo,     // NUEVO
  vacacion: !!r.vacacion,   // NUEVO
  user_id: uid,
  tenant_id: TENANT_ID,
  updated_by: uid,
}));

  const dRows = Object.entries(descs).map(([nombre, texto]) => ({
    nombre,
    texto,
    user_id: uid,
    tenant_id: TENANT_ID,
    updated_by: uid,
  }));

  // --- 1) UPSERT de todo ---
  {
    const { error } = await supabase
      .from("workers")
      .upsert(wRows, { onConflict: "tenant_id,id" });
    if (error) throw error;
  }
  {
    const { error } = await supabase
      .from("product_descs")
      .upsert(dRows, { onConflict: "tenant_id,nombre" });
    if (error) throw error;
  }
  {
    const { error } = await supabase
      .from("task_slices")
      .upsert(sRows, { onConflict: "tenant_id,id" });
    if (error) throw error;
  }
  {
    const { error } = await supabase
      .from("day_overrides")
      .upsert(oRows, { onConflict: "tenant_id,worker_id,fecha" });
    if (error) throw error;
  }

  // --- 2) Borrado selectivo ---

  // 2.a) task_slices: borra los IDs que ya no existen en memoria
  {
    const { data: existing, error } = await supabase
      .from("task_slices")
      .select("id")
      .eq("tenant_id", TENANT_ID);
    if (error) throw error;

    const keepSet = new Set(sRows.map((r) => r.id));
    const toDelete = (existing ?? [])
      .map((r: { id: string }) => r.id)
      .filter((id: string) => !keepSet.has(id));

    if (toDelete.length > 0) {
      const { error: delErr } = await supabase
        .from("task_slices")
        .delete()
        .in("id", toDelete)
        .eq("tenant_id", TENANT_ID);
      if (delErr) throw delErr;
    }
  }

  // 2.b) day_overrides: limpieza atómica con RPC (borra lo que sobra)
  {
    const keepKeys = oRows.map((r) => `${r.worker_id}|${r.fecha}`);
    if (keepKeys.length > 0) {
      const { error: rpcErr } = await supabase.rpc("delete_overrides_not_in", {
        tenant: TENANT_ID,
        keep_keys: keepKeys,
      });
      if (rpcErr) throw rpcErr;
    }
  }

  return true;
}

useEffect(() => {
  let mounted = true;

  async function init() {
    // 🔒 Bloquea autosave: todavía NO hemos hidratado datos
    hydratedRef.current = false;

    // 1) ¿Hay sesión ya abierta?
    const { data } = await supabase.auth.getSession();
    const uid  = data.session?.user?.id    ?? null;
    const mail = data.session?.user?.email ?? null;

    if (!mounted) return;

    setUserId(uid);
    setUserEmail(mail);

    // 2) Si hay usuario, carga todo desde Supabase
    if (uid) {
      try {
        setLoadingCloud(true);
        await seedIfEmpty(uid);
        await loadAll(uid);   // ← tu carga desde la nube
      } finally {
        if (mounted) setLoadingCloud(false);
      }
    } else {
      // 2-b) Si NO hay sesión, intenta cargar del almacenamiento local
      const snap = safeLocal<any>(STORAGE_KEY, null as any);
      if (snap && mounted) {
        setWorkers(snap.workers ?? []);
        setSlices(snap.slices ?? []);
        setOverrides(snap.overrides ?? {});
        setDescs(snap.descs ?? {});
      }
    }

    // ✅ Desbloquea autosave: YA estamos hidratados (nube o local)
    hydratedRef.current = true;
  }

  init();

  // 3) Suscripción a cambios de sesión (login / logout)
const { data: sub } = supabase.auth.onAuthStateChange(async (_event: AuthChangeEvent, session: Session | null) => {
    if (!mounted) return;

    // 🔒 Bloquea autosave mientras cambiamos de sesión / recargamos datos
    hydratedRef.current = false;

    const uid  = session?.user?.id    ?? null;
    const mail = session?.user?.email ?? null;
    setUserId(uid);
    setUserEmail(mail);

    if (uid) {
      try {
        setLoadingCloud(true);
        await seedIfEmpty(uid);
        await loadAll(uid);   // ← recarga desde la nube con el nuevo usuario
      } finally {
        setLoadingCloud(false);
      }
    } else {
      // Logout: intenta cargar desde local (por si tenías algo guardado sin sesión)
      const snap = safeLocal<any>(STORAGE_KEY, null as any);
      setWorkers(snap?.workers ?? []);
      setSlices(snap?.slices ?? []);
      setOverrides(snap?.overrides ?? {});
      setDescs(snap?.descs ?? {});
    }

    // ✅ Desbloquea autosave: ya hemos re-hidratado tras el cambio de sesión
    hydratedRef.current = true;
  });

  return () => {
    mounted = false;
    sub?.subscription?.unsubscribe();
  };
}, []); // ← sin dependencias: solo al montar

function isOwnChange<T>(payload: RealtimePostgresChangesPayload<T>, uid: string | null) {
  // Muchos eventos DELETE no traen "new", solo "old".
  // Este corte solo aplica a INSERT/UPDATE (cuando hay "new").
  const updatedBy = (payload as any)?.new?.updated_by ?? null;
  return !!uid && !!updatedBy && updatedBy === uid;
}

  // AUTOSAVE: guarda en Supabase cuando cambian datos (con debounce)
  
  useEffect(() => {
  if (!userId) return;               // sin sesión, no guardes nube
  if (loadingCloud) return;          // si está cargando, espera
  if (!hydratedRef.current) return;
   if (applyingRemoteRef.current) return;  // no guardar hasta hidratar

  const snapshot = JSON.stringify({ workers, slices, overrides, descs });
  if (snapshot === lastSavedRef.current) return;

  // Limpia cualquier temporizador anterior
  if (saveTimer.current) window.clearTimeout(saveTimer.current);

  // Flag para evitar setState tras cleanup
  let active = true;

  saveTimer.current = window.setTimeout(async () => {
    if (!active) return;

    setSavingCloud(true);
    setSaveError(null);

    try {
      await guardedSaveAll(userId);
      if (!active) return;
      lastSavedRef.current = snapshot;
    } catch (e: any) {
      if (!active) return;
      console.error("Autosave falló:", e);
      setSaveError(e?.message ?? String(e));
    } finally {
      if (!active) return;
      setSavingCloud(false);
    }
  }, 800);

  return () => {
    active = false;
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
  };
}, [workers, slices, overrides, descs, userId, loadingCloud]);

// 🔁 Realtime: un solo canal con handlers + estado del badge
useEffect(() => {
  // Solo tiene sentido con sesión (por RLS)
  if (!userId) return;

  const channel = supabase.channel("planner-realtime");
  const filter = `tenant_id=eq.${TENANT_ID}`;

  // WORKERS
  channel.on(
    "postgres_changes",
    { event: "*", schema: "public", table: "workers", filter },
    (payload: any) => {
      if (isOwnChange(payload, userId)) return;
      const { eventType, new: rowNew, old: rowOld } = payload;

      applyRemote(() => {
        if (eventType === "INSERT" || eventType === "UPDATE") {
          const w = mapRowToWorker(rowNew);
          setWorkers(prev => {
            const i = prev.findIndex(x => x.id === w.id);
            if (i === -1) return [...prev, w].sort((a,b)=>a.nombre.localeCompare(b.nombre));
            const copy = [...prev]; copy[i] = w; return copy;
          });
        } else if (eventType === "DELETE") {
          const id = rowOld?.id as string | undefined;
          if (!id) return;
          setWorkers(prev => prev.filter(x => x.id !== id));
          setSlices(prev => prev.filter(s => s.trabajadorId !== id));
          setOverrides(prev => { const c = { ...prev }; delete c[id]; return c; });
        }
      });
    }
  );

  // TASK_SLICES
  channel.on(
    "postgres_changes",
    { event: "*", schema: "public", table: "task_slices", filter },
    (payload: any) => {
      if (isOwnChange(payload, userId)) return;
      const { eventType, new: rowNew, old: rowOld } = payload;

      applyRemote(() => {
        if (eventType === "INSERT" || eventType === "UPDATE") {
          const s = mapRowToSlice(rowNew);
          setSlices(prev => {
            const i = prev.findIndex(x => x.id === s.id);
            if (i === -1) return [...prev, s];
            const copy = [...prev]; copy[i] = s; return copy;
          });
        } else if (eventType === "DELETE") {
          const id = rowOld?.id as string | undefined;
          if (!id) return;
          setSlices(prev => prev.filter(x => x.id !== id));
        }
      });
    }
  );

  // DAY_OVERRIDES
  channel.on(
    "postgres_changes",
    { event: "*", schema: "public", table: "day_overrides", filter },
    (payload: any) => {
      if (isOwnChange(payload, userId)) return;
      const { eventType, new: rowNew, old: rowOld } = payload;

      applyRemote(() => {
        if (eventType === "INSERT" || eventType === "UPDATE") {
          setOverrides(prev => mergeOverrideRow(prev, {
            worker_id: rowNew.worker_id,
            fecha: rowNew.fecha,
            extra: rowNew.extra,
            sabado: rowNew.sabado,
            domingo: rowNew.domingo,
            vacacion: rowNew.vacacion,
          }));
        } else if (eventType === "DELETE") {
          const worker_id = rowOld?.worker_id as string | undefined;
          const fecha     = rowOld?.fecha as string | undefined;
          if (!worker_id || !fecha) return;
          setOverrides(prev => {
            const byW = { ...(prev[worker_id] || {}) };
            delete byW[fecha];
            return { ...prev, [worker_id]: byW };
          });
        }
      });
    }
  );

  // PRODUCT_DESCS
  channel.on(
    "postgres_changes",
    { event: "*", schema: "public", table: "product_descs", filter },
    (payload: any) => {
      if (isOwnChange(payload, userId)) return;
      const { eventType, new: rowNew, old: rowOld } = payload;

      applyRemote(() => {
        if (eventType === "INSERT" || eventType === "UPDATE") {
          setDescs(prev => ({ ...prev, [rowNew.nombre]: rowNew.texto ?? "" }));
        } else if (eventType === "DELETE") {
          const nombre = rowOld?.nombre as string | undefined;
          if (!nombre) return;
          setDescs(prev => { const c = { ...prev }; delete c[nombre]; return c; });
        }
      });
    }
  );

  // Estado del canal → badge Realtime
  channel.subscribe((status: "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR") => {

    if (status === "SUBSCRIBED") setRtStatus("connected");
    else if (status === "TIMED_OUT" || status === "CLOSED") setRtStatus("connecting");
    else if (status === "CHANNEL_ERROR") setRtStatus("error");
  });

  // Limpieza
  return () => {
    supabase.removeChannel(channel);
    setRtStatus("connecting"); // opcional
  };
}, [userId]);



  // === NUEVO: guardado local automático cuando NO hay sesión ===
  useEffect(() => {
  if (userId) return;               // con sesión, nube
  if (!hydratedRef.current) return; // ⬅️ evita guardar antes de hidratar
  const snapshot = JSON.stringify({ workers, slices, overrides, descs });
  try { localStorage.setItem(STORAGE_KEY, snapshot); } catch {}
}, [workers, slices, overrides, descs, userId]);



  // Copia automática inicial y cada 10 minutos
useEffect(() => {
  saveBackup("auto"); // copia al abrir

  const id = setInterval(() => {
    saveBackup("auto"); // copia cada 10 minutos
  }, 10 * 60 * 1000);

  // también guarda al ocultar pestaña
  const onVis = () => {
    if (document.visibilityState === "hidden") {
      saveBackup("auto");
    }
  };
  document.addEventListener("visibilitychange", onVis);

  return () => {
    clearInterval(id);
    document.removeEventListener("visibilitychange", onVis);
  };
}, []);


  function triggerPrint(mode: PrintMode) {
    setPrintMode(mode);
    setTimeout(() => window.print(), 80);
    setTimeout(() => setPrintMode("none"), 600);
  }

  // Autenticación simple (bloqueo)
  function tryUnlock() {
    const p = prompt("Introduce la contraseña para editar:");
    if (p === PASSWORD) setLocked(false);
    else alert("Contraseña incorrecta");
  }
  function lock() {
    setLocked(true);
  }

  // 🔽🔽🔽 AÑADIR AQUÍ el bloque de login/logout 🔽🔽🔽

  async function sendMagicLink() {
    setAuthMsg(null);
    const email = loginEmail.trim();
    if (!email) { setAuthMsg("Escribe tu email."); return; }
    setSendingLink(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: window.location.origin, // vuelve a la misma app
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
    // Limpia opcionalmente estados locales:
    // setWorkers([]); setSlices([]); setOverrides({}); setDescs({});
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

  function moveWorkerToTop(id: string) {
  setWorkers(prev => {
    const i = prev.findIndex(w => w.id === id);
    if (i <= 0) return prev; // ya está primero o no existe
    const chosen = prev[i];
    const rest = prev.filter((_, idx) => idx !== i);
    return [chosen, ...rest];
  });
}

  // Trabajadores
  function addWorker() {
  if (!canEdit) return;
  const name = nuevoTrabajador.trim();
  if (!name) return;
  const id = "W" + Math.random().toString(36).slice(2, 6);
  setWorkers((prev) => [
    ...prev,
    { id, nombre: name, jornada: { lu: 8.5, ma: 8.5, mi: 8.5, ju: 8.5, vi: 6 } }
  ]);
  setNuevoTrabajador("");
}
  function editWorker(id: string, patch: Partial<Worker>) {
    if (!canEdit) return;
    setWorkers((prev) => prev.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  }
// ——— Eliminar trabajador + limpiar sus datos ———
function deleteWorker(id: string) {
  if (!canEdit) return;
  const w = workers.find(x => x.id === id);
  const name = w?.nombre || id;
  if (!confirm(`¿Eliminar a "${name}" y todas sus asignaciones? Esta acción no se puede deshacer.`)) return;

  // 1) Quita el trabajador de la lista
  setWorkers(prev => prev.filter(x => x.id !== id));

  // 2) Elimina todos sus bloques/horas
  setSlices(prev => prev.filter(s => s.trabajadorId !== id));

  // 3) Borra overrides (extras/sábados) del trabajador
  setOverrides(prev => {
    const copy = { ...prev };
    delete copy[id];
    return copy;
  });
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

function editOverrideForDay(worker: Worker, date: Date) {
  if (!canEdit) return;
  const f = fmt(date);
  if (!f) return;

  const ow = overrides[worker.id]?.[f] ?? {
  extra: 0,
  sabado: false,
  domingo: false,
  vacacion: false,
};

  const dow = getDay(date); // 0=domingo, 6=sábado

  // 1) Extras (solo L–V)
  let extra = Number(ow.extra ?? 0);
  if (dow >= 1 && dow <= 5) {
    const extraStr = prompt(`Horas extra para ${worker.nombre} el ${f} (solo L–V):`, String(extra));
    if (extraStr === null) return;
    const e = Number(extraStr);
    if (!isFinite(e) || e < 0 || e > 8) return;
    extra = e;
  }

  // 2) Sábado
  let sab = !!ow.sabado;
  if (dow === 6) {
    const resp = prompt(`¿Trabaja el sábado ${f}? (sí=1 / no=0):`, sab ? "1" : "0");
    if (resp === null) return;
    sab = resp.trim() === "1";
  }

  // 3) Domingo
  let dom = !!ow.domingo;
  if (dow === 0) {
    const resp = prompt(`¿Trabaja el domingo ${f}? (sí=1 / no=0):`, dom ? "1" : "0");
    if (resp === null) return;
    dom = resp.trim() === "1";
  }

  // 4) Persistir override del día
  const nextOverrides: OverridesState = (() => {
    const byWorker = { ...(overrides[worker.id] || {}) };
    const cur = { ...(byWorker[f] || {}) };

    // extras solo si L–V
    if (dow >= 1 && dow <= 5) cur.extra = extra;
    // sábado/domingo según corresponda
    if (dow === 6) {
      if (sab) cur.sabado = true; else delete cur.sabado;
    }
    if (dow === 0) {
      if (dom) cur.domingo = true; else delete cur.domingo;
    }

    // limpiar si queda vacío
    if (!cur.extra && !cur.sabado && !cur.domingo && !cur.vacacion) delete byWorker[f];
    else byWorker[f] = cur;

    return { ...overrides, [worker.id]: byWorker };
  })();

  setOverrides(nextOverrides);

  // 5) Reempacar desde ese día con los overrides ya cambiados
  setSlices(prev => {
    const newPlan = compactFrom(worker, f, nextOverrides, prev);
    const others = prev.filter(s => s.trabajadorId !== worker.id);
    return [...others, ...newPlan];
  });
  reflowFromWorkerWithOverrides(worker.id, f, nextOverrides);
  compactarBloques(worker.id);
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

  // 1) Nombre de la urgencia (con ⚠️ automático)
  const baseProd = prompt("Producto a insertar (urgente):", "Urgente");
  if (!baseProd) return;

  const prod = baseProd.trim();
  const nombreFinal =
    /^⚠️/.test(prod) || /urgenc/i.test(prod)
      ? prod // si ya lo tiene
      : `⚠️ ${prod}`; // añade icono automáticamente

  const hStr = prompt("Horas de esa urgencia:", "4");
  const h = Number(hStr);
  if (!isFinite(h) || h <= 0) return;

  const startISO = toLocalISO(date);

  // 2) Bloques anteriores y los que van a refluírse desde startISO
  const before = slices
    .filter(s => s.trabajadorId === worker.id && s.fecha < startISO)
    .sort((a,b) => a.fecha.localeCompare(b.fecha));

  const fromHere = slices
    .filter(s => s.trabajadorId === worker.id && s.fecha >= startISO)
    .sort((a,b) =>
      a.fecha < b.fecha ? -1 :
      a.fecha > b.fecha ? 1  :
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );

  // 3) Cola con la URGENCIA primero (prioridad máxima)
  const urgentTaskId = "T" + Math.random().toString(36).slice(2, 8);
  const queue: QueueItem[] = [
    { taskId: urgentTaskId, producto: nombreFinal, color: URGENT_COLOR, horas: Math.round(h * 2) / 2 },
    ...fromHere.map(s => ({ taskId: s.taskId, producto: s.producto, color: s.color, horas: s.horas })),
  ];

  // 4) Reempacado de ese día en adelante
  const rebuilt: TaskSlice[] = [];
  let dayISO = startISO;
  let guard = 0;

  function newId() {
    return (crypto as any)?.randomUUID ? (crypto as any).randomUUID() : "S" + Math.random().toString(36).slice(2, 10);
  }

  while (queue.length > 0 && guard < 365) {
    guard++;
    let capLeft = Math.max(0, capacidadDia(worker, new Date(dayISO), overrides));

    if (capLeft > 0) {
      while (queue.length > 0 && capLeft > 1e-9) {
        const head = queue[0];
        const take = Math.min(head.horas, capLeft);
        if (take > 1e-9) {
          rebuilt.push({
            id: newId(),
            taskId: head.taskId,
            producto: head.producto,
            fecha: dayISO,
            horas: Math.round(take * 2) / 2,
            trabajadorId: worker.id,
            color: head.color, // ⚠️ amarillo para urgencias
          });
          head.horas = Math.round((head.horas - take) * 2) / 2;
          capLeft    = Math.round((capLeft - take) * 2) / 2;
        }
        if (head.horas <= 1e-9) queue.shift();
      }
    }

    const d = fromLocalISO(dayISO);
const nextDay = addDays(d, 1);
dayISO = toLocalISO(nextDay);
  }

  // 5) Actualizamos el estado global
  const restOthers = slices.filter(s => s.trabajadorId !== worker.id);
  setSlices([...before, ...rebuilt, ...restOthers]);

  // 6) Compactamos por seguridad (combina tramos del mismo día)
  compactarBloques(worker.id);
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

// Lista todos los días (ISO: YYYY-MM-DD) entre dos fechas (incluidas)
function eachDayISO(fromISO: string, toISO: string): string[] {
  const from = fromLocalISO(fromISO);
  const to   = fromLocalISO(toISO);
  const out: string[] = [];
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    out.push(toLocalISO(d));
  }
  return out;
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

  function aplicarEdicion() {
    if (!canEdit) return;
    const w = workers.find((x)=>x.id===ebWorker);
    if (!w || !ebSelected) return;
    const match = ebMatches.find(m=>m.taskId===ebSelected);
    if (!match) return;
    const nuevoTotal = Math.max(0.5, Math.round(Number(ebHoras)*2)/2);

    setSlices(prev=>{
      const color = colorFromId(ebSelected);
      const restantes = prev.filter(s => !(s.taskId===ebSelected && s.trabajadorId===w.id));
      const start = fromLocalISO(match.startF);
      const plan = planificarBloqueAuto(
        ebNombre.trim(),
        nuevoTotal,
        w,
        start,
        base,
        restantes,
        overrides
      ).map(s=>({...s, taskId: ebSelected, color}));
      return [...restantes, ...plan];
    });
  }

  // === Helpers "Actualizar día trabajador" ===
function dayKeyOf(d: Date) {
  // Asegura el formato YYYY-MM-DD como el que usa el calendario
  // Si ya tienes una util para esto, usa la tuya.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/**
 * Edita las horas REALES de un bloque en un día concreto y replanifica el resto.
 * - Fija el tramo del día seleccionado a newHoras (mín 0.5 en pasos de 0.5)
 * - Recalcula el resto del bloque a partir del día siguiente, empujando/ajustando como siempre.
 */
function updateBlockHoursForDay(taskId: string, trabajadorId: string, diaISO: string, newHoras: number) {
  if (!canEdit) return;

  const w = workers.find(x => x.id === trabajadorId);
  if (!w) return;

  const safeHoras = Math.max(0.5, Math.round(Number(newHoras) * 2) / 2);
  if (!isFinite(safeHoras)) return;

  setSlices(prev => {
    // Todas las partes del bloque de ese trabajador
    const parts = prev.filter(s => s.taskId === taskId && s.trabajadorId === trabajadorId);
    if (parts.length === 0) return prev;

    // Slice del día elegido
    const today = parts.find(s => s.fecha === diaISO);
    if (!today) return prev;

    // Suma total actual y suma realizada hasta el día seleccionado (incluyéndolo)
    const totalAntes = parts.reduce((a, s) => a + s.horas, 0);
    const sumPrevDays = parts
      .filter(s => s.fecha < diaISO)
      .reduce((a, s) => a + s.horas, 0);

    // Horas restantes a partir del día siguiente:
    const remaining = Math.max(0, Math.round((totalAntes - (sumPrevDays + safeHoras)) * 2) / 2);

    // 1) Quitamos todas las slices del bloque desde "hoy" inclusive
    const sinBloqueDesdeHoy = prev.filter(s => !(s.taskId === taskId && s.trabajadorId === trabajadorId && s.fecha >= diaISO));

    // 2) Insertamos la slice fija de HOY con las horas reales
    const fixedToday = { ...today, horas: safeHoras, fecha: diaISO };

    // 3) Replanificar el resto desde el día siguiente
    let nuevos: typeof prev = [fixedToday];
    if (remaining > 0) {
      const nextDay = addDays(fromLocalISO(diaISO), 1);

      const replan = planificarBloqueAuto(
        today.producto,
        remaining,
        w,
        nextDay,
        base,
        sinBloqueDesdeHoy, // planificar contra el resto de slices
        overrides
      ).map(s => ({ ...s, taskId: today.taskId, color: colorFromId(today.taskId) }));

      nuevos = [fixedToday, ...replan];
    }

    // Resultado final de slices
    const result = [...sinBloqueDesdeHoy, ...nuevos];

    // === NUEVO: sobreasignar horas extras automáticamente si hace falta ===
    // 1) Total de horas usadas HOY por este trabajador (con el cambio aplicado)
    // Total de horas usadas HOY (con el cambio aplicado)
const totalHoy = Math.round(result
  .filter(s => s.trabajadorId === w.id && s.fecha === diaISO)
  .reduce((a, s) => a + s.horas, 0) * 2) / 2;

// Capacidad del día con overrides actuales
const capacidadHoy = capacidadDia(w, fromLocalISO(diaISO), overrides);
const exceso = Math.max(0, Math.round((totalHoy - capacidadHoy) * 2) / 2);


    if (exceso > 0) {
  setOverrides((prevOv: OverridesState) => {
    const byWorker = { ...(prevOv[w.id] || {}) };
    const cur = byWorker[diaISO] || { extra: 0, sabado: false };
    byWorker[diaISO] = {
      extra: Math.round((Number(cur.extra ?? 0) + exceso) * 2) / 2,
      sabado: !!cur.sabado,
    };
    return { ...prevOv, [w.id]: byWorker };
  });
}

    return result;
  });
}

/**
 * Añade un bloque NUEVO (incidencia) para un trabajador empezando en un día concreto.
 * Empuja y replanifica como el alta normal.
 */

function addNewBlockFromDay(trabajadorId: string, diaISO: string, producto: string, horas: number) {
  if (!canEdit) return;

  const w = workers.find(x => x.id === trabajadorId);
  if (!w) return;

  const safeHoras = Math.max(0.5, Math.round(Number(horas) * 2) / 2);
  if (!isFinite(safeHoras) || safeHoras <= 0) return;

  const newTaskId = `t${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  setSlices(prev => {
    // Planificar el nuevo bloque empezando en el día indicado, empujando como siempre
    const plan = planificarBloqueAuto(
      producto.trim(),
      safeHoras,
      w,
      fromLocalISO(diaISO),
      base,
      prev,         // planificar contra lo que ya existe
      overrides
    ).map(s => ({ ...s, taskId: newTaskId, color: colorFromId(newTaskId) }));

    const result = [...prev, ...plan];

    // === NUEVO: sobreasignar horas extras si ese mismo día se supera la capacidad ===
    // 1) Total de horas usadas HOY por este trabajador (con el nuevo bloque ya añadido)
    // === Sobreasignar horas extras si se supera la capacidad ===
const totalHoy = Math.round(result
  .filter(s => s.trabajadorId === w.id && s.fecha === diaISO)
  .reduce((a, s) => a + s.horas, 0) * 2) / 2;

const capacidadHoy = capacidadDia(w, fromLocalISO(diaISO), overrides);
const exceso = Math.max(0, Math.round((totalHoy - capacidadHoy) * 2) / 2);

if (exceso > 0) {
  setOverrides((prevOv: OverridesState) => {
    const byWorker = { ...(prevOv[w.id] || {}) };
    const cur = byWorker[diaISO] || { extra: 0, sabado: false };
    byWorker[diaISO] = {
      extra: Math.round((Number(cur.extra ?? 0) + exceso) * 2) / 2,
      sabado: !!cur.sabado,
    };
    return { ...prevOv, [w.id]: byWorker };
  });
}

    return result;
  });
}

// === Funciones de copias de seguridad ===
function makeSnapshot(): PlannerSnapshot {
  return {
    version: 1,
    ts: Date.now(),
    workers,
    slices,
    overrides,
    descs,
  };
}

function readBackupIndex(): string[] {
  try {
    const raw = localStorage.getItem(BACKUP_INDEX_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeBackupIndex(ids: string[]) {
  try {
    localStorage.setItem(BACKUP_INDEX_KEY, JSON.stringify(ids));
  } catch {}
}

function saveBackup(manualLabel?: string) {
  try {
    const snap = makeSnapshot();
    const id = new Date(snap.ts).toISOString().replace(/[:.]/g, "-");
    const key = `planner:backup:${id}${manualLabel ? ":" + manualLabel : ""}`;
    localStorage.setItem(key, JSON.stringify(snap));

    const index = readBackupIndex();
    index.unshift(key);
    const trimmed = index.slice(0, MAX_BACKUPS);
    index.slice(MAX_BACKUPS).forEach(k => localStorage.removeItem(k));
    writeBackupIndex(trimmed);

    return key;
  } catch (e) {
    console.error("Error guardando copia:", e);
    return null;
  }
}

function getLastBackupKey(): string | null {
  const index = readBackupIndex();
  return index.length > 0 ? index[0] : null;
}

function readBackupByKey(key: string): PlannerSnapshot | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function restoreFromSnapshot(snap: PlannerSnapshot) {
  setWorkers(snap.workers);
  setSlices(snap.slices);
  setOverrides(snap.overrides as any);
  setDescs(snap.descs as any);
}

function restoreLastBackup() {
  const key = getLastBackupKey();
  if (!key) {
    alert("No hay copias disponibles.");
    return;
  }
  const snap = readBackupByKey(key);
  if (!snap) {
    alert("No se pudo leer la copia.");
    return;
  }
  const fecha = new Date(snap.ts).toLocaleString();
  if (confirm(`¿Restaurar la copia de ${fecha}?`)) {
    restoreFromSnapshot(snap);
    alert("Copia restaurada correctamente.");
  }
}

function downloadLastBackup() {
  const key = getLastBackupKey();
  if (!key) {
    alert("No hay copias disponibles.");
    return;
  }
  const snap = readBackupByKey(key);
  if (!snap) {
    alert("No se pudo leer la copia.");
    return;
  }
  const blob = new Blob([JSON.stringify(snap, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date(snap.ts).toISOString().replace(/[:.]/g, "-");
  a.href = url;
  a.download = `planificador-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

  // === Copias en Supabase ===
  async function saveCloudBackup() {
    if (!userId) { alert("Inicia sesión para guardar copia en la nube."); return; }
    const snap = {
      version: 1,
      ts: Date.now(),
      workers, slices, overrides, descs,
    };
    const { error } = await supabase.from("backups").insert({
      user_id: userId,
      tenant_id: TENANT_ID,
      payload: snap,
    } as any);
    if (error) {
      alert("No se pudo guardar la copia en la nube: " + error.message);
    } else {
      alert("Copia en la nube guardada.");
    }
  }

  async function restoreLatestCloudBackup() {
    if (!userId) { alert("Inicia sesión para restaurar copias de la nube."); return; }
    const { data, error } = await supabase
      .from("backups")
      .select("*")
      .eq("user_id", userId)
      .eq("tenant_id", TENANT_ID)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) { alert("Error leyendo copias: " + error.message); return; }
    if (!data || !data.length) { alert("No hay copias en la nube."); return; }
    const snap = data[0].payload;
    if (!snap) { alert("Copia inválida."); return; }
    if (confirm(`Restaurar la última copia en la nube (${new Date(snap.ts).toLocaleString()})?`)) {
      // Reutilizamos la misma función de restaurar local
      setWorkers(snap.workers ?? []);
      setSlices(snap.slices ?? []);
      setOverrides(snap.overrides ?? {});
      setDescs(snap.descs ?? {});
      alert("Copia restaurada desde la nube.");
    }
  }
  
  async function guardedSaveAll(uid: string) {
  const myTurn = ++saveEpoch.current;

  const ok = await ensureSessionOrExplain();
  if (!ok) return; // no guardes si no hay sesión o estás offline

  try {
    await saveAll(uid);
  } finally {
    if (myTurn !== saveEpoch.current) {
      // había otro guardado más nuevo; no hacemos nada más
    }
  }
}

function borrarVacacionUnDia(workerId: string, iso: string) {
  setOverrides((prev: OverridesState) => {
    const byW = { ...(prev[workerId] || {}) };
    const cur = { ...(byW[iso] || {}) };
    delete cur.vacacion;
    if (!cur.extra && !cur.sabado && !cur.domingo && !cur.vacacion) {
      delete byW[iso];
    } else {
      byW[iso] = cur;
    }
    return { ...prev, [workerId]: byW };
  });
}

function aplicarExtrasRango() {
  if (!gmWorker || !gmFrom || !gmTo) return;

  const dias = eachDayISO(gmFrom, gmTo);

  // Calcula el NUEVO estado primero
  const nextOverrides: OverridesState = (() => {
    const prev = overrides;
    const byW = { ...(prev[gmWorker] || {}) };

    for (const iso of dias) {
      const dow = getDay(fromLocalISO(iso)); // 0=domingo, 1=lunes,...,6=sábado
      const cur = { ...(byW[iso] || {}) };

      if (gmExtra === 0) {
        // ✅ Permitir BORRAR extras también en DOMINGOS (antes se saltaba)
        if ("extra" in cur) {
          delete cur.extra;
        }
        // Limpia el override si queda vacío
        if (!cur.extra && !cur.sabado && !cur.domingo && !cur.vacacion) {
          delete byW[iso];
        } else {
          byW[iso] = cur;
        }
      } else {
        // ➕ Añadir extras SOLO L–V (no sábados, no domingos)
        if (dow === 0 || dow === 6) continue;
        cur.extra = Math.round(gmExtra * 2) / 2;
        byW[iso] = cur;
      }
    }

    return { ...prev, [gmWorker]: byW };
  })();

  // Aplica el estado…
  setOverrides(nextOverrides);

  // …y refluye con el ESTADO NUEVO
  const startISO = gmFrom <= gmTo ? gmFrom : gmTo;
  reflowFromWorkerWithOverrides(gmWorker, startISO, nextOverrides);
  compactarBloques(gmWorker);
}





function marcarVacacionesRango() {
  if (!gmWorker || !gmFrom || !gmTo) return;
  const dias = eachDayISO(gmFrom, gmTo);

  const nextOverrides: OverridesState = (() => {
    const prev = overrides;
    const byW = { ...(prev[gmWorker] || {}) };
    for (const iso of dias) {
      byW[iso] = { ...(byW[iso] || {}), vacacion: true, extra: 0 };
    }
    return { ...prev, [gmWorker]: byW };
  })();

  setOverrides(nextOverrides);
  const startISO = gmFrom <= gmTo ? gmFrom : gmTo;
  reflowFromWorkerWithOverrides(gmWorker, startISO, nextOverrides);
  compactarBloques(gmWorker);
}


function borrarVacacionesRango() {
  if (!gmWorker || !gmFrom || !gmTo) return;
  const dias = eachDayISO(gmFrom, gmTo);

  const nextOverrides: OverridesState = (() => {
    const prev = overrides;
    const byW = { ...(prev[gmWorker] || {}) };
    for (const iso of dias) {
      const cur = { ...(byW[iso] || {}) };
      delete cur.vacacion;
      if (!cur.extra && !cur.sabado && !cur.domingo && !cur.vacacion) delete byW[iso];
      else byW[iso] = cur;
    }
    return { ...prev, [gmWorker]: byW };
  })();

  setOverrides(nextOverrides);
  const startISO = gmFrom <= gmTo ? gmFrom : gmTo;
  reflowFromWorkerWithOverrides(gmWorker, startISO, nextOverrides);
  compactarBloques(gmWorker);
}


// ============ Re-empacado de tramos desde un día hacia delante ============
function newId() {
  // usa tu generador si tienes (por ejemplo nanoid/uuid). Esto vale en navegadores modernos:
  return (crypto as any)?.randomUUID ? (crypto as any).randomUUID() : String(Math.random()).slice(2);
}



/**
 * Refluye TODOS los tramos (slices) del trabajador a partir de startISO inclusive,
 * rellenando huecos en cada día según capacidadDia(w, date, overrides).
 * - Respeta vacaciones (capacidad 0) y sab/domingo ON/OFF ya que capacidadDia lo decide.
 * - Puede partir un bloque en varios días (crea nuevos slices con mismo taskId).
 */
function reflowFromWorker(workerId: string, startISO: string) {
  const w = workers.find(x => x.id === workerId);
  if (!w) return;

  setSlices(prev => {
    const reflowedForWorker = compactFrom(w, startISO, overrides, prev);
    const others = prev.filter(s => s.trabajadorId !== w.id);
    return [...others, ...reflowedForWorker];
  });
}

function reflowFromWorkerWithOverrides(workerId: string, startISO: string, ov: OverridesState) {
  const w = workers.find(x => x.id === workerId);
  if (!w) return;

  setSlices(prev => {
    const reflowedForWorker = compactFrom(w, startISO, ov, prev);
    const others = prev.filter(s => s.trabajadorId !== w.id);
    return [...others, ...reflowedForWorker];
  });
}



function reflowFromWorkerPure(
  baseSlices: TaskSlice[],
  worker: Worker,
  startISO: string,
  ov: OverridesState
): TaskSlice[] {
  const before = baseSlices.filter(s => s.trabajadorId === worker.id && s.fecha < startISO);
  const fromHere = baseSlices
    .filter(s => s.trabajadorId === worker.id && s.fecha >= startISO)
    .sort((a, b) =>
      a.fecha < b.fecha ? -1 :
      a.fecha > b.fecha ?  1 :
      (a.id   < b.id   ? -1 : a.id > b.id ? 1 : 0)
    );

  const queue = fromHere.map(s => ({
    taskId: s.taskId,
    producto: s.producto,
    color: s.color,
    horas: s.horas,
  }));

  const rebuilt: TaskSlice[] = [];
  let guard = 0;
  let dayISO = startISO;

  while (queue.length > 0 && guard < 365) {
    guard++;
    let capLeft = Math.max(0, capacidadDia(worker, fromLocalISO(dayISO), ov));

    if (capLeft > 0) {
      while (queue.length > 0 && capLeft > 1e-9) {
        const head = queue[0];
        const take = Math.min(head.horas, capLeft);
        if (take > 1e-9) {
          rebuilt.push({
            id: newId(),
            taskId: head.taskId,
            producto: head.producto,
            fecha: dayISO,
            horas: Math.round(take * 2) / 2,
            trabajadorId: worker.id,
            color: head.color,
          });
          head.horas = Math.round((head.horas - take) * 2) / 2;
          capLeft    = Math.round((capLeft    - take) * 2) / 2;
        }
        if (head.horas <= 1e-9) queue.shift();
        if (capLeft < 1e-9) capLeft = 0;
      }
    }

    dayISO = toLocalISO(addDays(fromLocalISO(dayISO), 1));
  }

  const restOthers = baseSlices.filter(s => s.trabajadorId !== worker.id);
  return [...before, ...rebuilt, ...restOthers];
}

function reflowFromWorkerPurePinned(
  baseSlices: TaskSlice[],
  worker: Worker,
  startISO: string,
  ov: OverridesState
): TaskSlice[] {
  const before = baseSlices
    .filter(s => s.trabajadorId === worker.id && s.fecha < startISO);

  const fromHere = baseSlices
    .filter(s => s.trabajadorId === worker.id && s.fecha >= startISO)
    .sort((a, b) =>
      a.fecha < b.fecha ? -1 :
      a.fecha > b.fecha ?  1 :
      (a.id   < b.id   ? -1 : a.id > b.id ? 1 : 0)
    );

  // “pinned” = URGENCIAS: no se mueven de su día
  const pinned  = fromHere.filter(isUrgentSlice);
  const movable = fromHere.filter(s => !isUrgentSlice(s));

  // Cola con lo movible (agregado por bloque)
  const queue = aggregateToQueue(movable).map(q => ({ ...q }));

  const rebuilt: TaskSlice[] = [];
  let dayISO = startISO;
  let guard = 0;

  while ((queue.length > 0 || pinned.length > 0) && guard < 365) {
    guard++;

    let capLeft = Math.max(0, capacidadDia(worker, fromLocalISO(dayISO), ov));

    // 1) Coloca primero las urgencias del propio día (no se tocan)
    const todaysPinned = pinned.filter(s => s.fecha === dayISO);
    for (const p of todaysPinned) {
      rebuilt.push({ ...p });
      capLeft = Math.max(0, Math.round((capLeft - p.horas) * 2) / 2);
    }

    // 2) Rellena con la cola movible
    while (queue.length > 0 && capLeft > 1e-9) {
      const head = queue[0];
      const take = Math.min(head.horas, capLeft);
      if (take > 1e-9) {
        rebuilt.push({
          id: newId(),
          taskId: head.taskId,
          producto: head.producto,
          fecha: dayISO,
          horas: Math.round(take * 2) / 2,
          trabajadorId: worker.id,
          color: head.color,
        });
        head.horas = Math.round((head.horas - take) * 2) / 2;
        capLeft    = Math.round((capLeft    - take) * 2) / 2;
      }
      if (head.horas <= 1e-9) queue.shift();
    }

    dayISO = toLocalISO(addDays(fromLocalISO(dayISO), 1));
  }

  const restOthers = baseSlices.filter(s => s.trabajadorId !== worker.id);
  return [...before, ...rebuilt, ...restOthers];
}


function compactarBloques(workerId: string) {
  setSlices((prev) => {
    const delTrabajador = prev
      .filter((s) => s.trabajadorId === workerId)
      .sort((a, b) => {
        if (a.taskId < b.taskId) return -1;
        if (a.taskId > b.taskId) return 1;
        if (a.fecha < b.fecha) return -1;
        if (a.fecha > b.fecha) return 1;
        return 0;
      });

    const compactados: TaskSlice[] = [];
    for (const s of delTrabajador) {
      const last = compactados.at(-1);
      if (
        last &&
        last.taskId === s.taskId &&
        last.trabajadorId === s.trabajadorId &&
        last.fecha === s.fecha
      ) {
        // Mismo día y bloque → combinar horas
        last.horas = Math.round((last.horas + s.horas) * 2) / 2;
      } else {
        compactados.push({ ...s });
      }
    }

    // Une de nuevo con los demás trabajadores
    const otros = prev.filter((s) => s.trabajadorId !== workerId);
    return [...otros, ...compactados];
  });
}
// === Mappers fila -> estado local ===
function mapRowToSlice(r: any): TaskSlice {
  return {
    id: r.id,
    taskId: r.task_id,
    producto: r.producto,
    fecha: r.fecha,
    horas: Number(r.horas),
    trabajadorId: r.trabajador_id,
    color: r.color,
  };
}

function mapRowToWorker(r: any): Worker {
  return {
    id: r.id,
    nombre: r.nombre,
    jornada: {
      lu: Number(r.lu_hours ?? 8.5),
      ma: Number(r.ma_hours ?? 8.5),
      mi: Number(r.mi_hours ?? 8.5),
      ju: Number(r.ju_hours ?? 8.5),
      vi: Number(r.vi_hours ?? 6),
    },
  };
}

// day_overrides: estructura { [workerId]: { [fechaISO]: { extra?, sabado?, domingo?, vacacion? } } }
function mergeOverrideRow(
  prev: OverridesState,
  row: { worker_id: string; fecha: string; extra?: number; sabado?: boolean; domingo?: boolean; vacacion?: boolean }
): OverridesState {
  const byW = { ...(prev[row.worker_id] || {}) };
  const cur = {
    ...(byW[row.fecha] || {}),
    extra: Number(row.extra ?? 0),
    sabado: !!row.sabado,
    domingo: !!row.domingo,
    vacacion: !!row.vacacion,
  };

  // limpia si no queda nada relevante
  if (!cur.extra && !cur.sabado && !cur.domingo && !cur.vacacion) {
    delete byW[row.fecha];
  } else {
    byW[row.fecha] = cur;
  }
  return { ...prev, [row.worker_id]: byW };
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
          <h1 style={appTitle}>MONTAJES DELSAZ — PLANIFICACION TALLERES</h1>
        </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
    <div style={{ fontWeight: 700, color: "#fff", marginRight: 8 }}>{monthYear(base)}</div>
    <button style={btnLabeled} onClick={() => setBase(addMonths(base, -1))}>◀ Mes anterior</button>
    <button style={btnLabeled} onClick={() => setBase(addMonths(base, 1))}>Siguiente mes ▶</button>

{/* Indicador de conexión Realtime */}
<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
  <RTBadge status={rtStatus} />
</div>


    {locked ? (
      <button style={btnUnlock} className="no-print" onClick={tryUnlock}>🔒 Desbloquear</button>
    ) : (
      <button style={btnLock} className="no-print" onClick={lock}>🔓 Bloquear</button>
    )}

    {/* ——— separador visual ——— */}
    <div style={{ width: 1, height: 22, background: "rgba(255,255,255,.25)", margin: "0 6px" }} />

    {/* === Estado de guardado / error (ya tienes savingCloud y saveError) === */}
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {savingCloud && <span style={{ color: "#a7f3d0" }}>Guardando…</span>}
      {saveError && <span style={{ color: "#fecaca" }} title={saveError}>⚠ Error al guardar</span>}
    </div>

    {/* ——— separador visual ——— */}
    <div style={{ width: 1, height: 22, background: "rgba(255,255,255,.25)", margin: "0 6px" }} />
       
    {userId ? (
      // Conectado
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "#d1d5db", fontSize: 13 }}>
          Conectado{userEmail ? `: ${userEmail}` : "" }
        </span>
        <button style={btnLabeled} className="no-print" onClick={logout}>Cerrar sesión</button>
      </div>
    ) : (
      // No conectado → pedir email y enviar enlace mágico
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          className="no-print"
          style={{ ...input, width: 220 }}
          type="email"
          placeholder="tu-correo@empresa.com"
          value={loginEmail}
          onChange={(e) => setLoginEmail(e.target.value)}
        />
        <button
          className="no-print"
          style={btnPrimary}
          onClick={sendMagicLink}
          disabled={sendingLink}
          title="Te enviaré un correo con un enlace para entrar"
        >
          {sendingLink ? "Enviando…" : "Enviarme enlace"}
        </button>
        {authMsg && <span style={{ color: "#fff", fontSize: 12, opacity: 0.9 }}>{authMsg}</span>}
      </div>
    )}
  </div>

      </header>

      {/* LAYOUT PRINCIPAL */}
      <div style={mainLayout}>
        {/* COLUMNA PRINCIPAL */}
        <div style={{ minWidth: 0 }}>
         


          {/* FORM + TRABAJADORES */}
          <div style={panelRow} className="no-print">
            <div style={panel}>
  <div
    style={{ ...panelTitle, ...collapsibleHeader }}
    onClick={() => setIsNewBlockOpen(v => !v)}
    aria-expanded={isNewBlockOpen}
  >
    <span>Nuevo bloque</span>
    <span style={caret}>{isNewBlockOpen ? "▾" : "▸"}</span>
  </div>

  {isNewBlockOpen && (
    <div style={panelInner}>
      <div style={grid2}>
        <label style={label}>Producto</label>
        <input
          style={disabledIf(input, locked)}
          disabled={locked}
          value={form.producto}
          onChange={(e) => setForm({ ...form, producto: e.target.value })}
        />

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
        <select
          style={disabledIf(input, locked)}
          disabled={locked}
          value={form.trabajadorId}
          onChange={(e) => {
            const id = e.target.value;
            setForm(prev => ({ ...prev, trabajadorId: id }));
            moveWorkerToTop(id);
          }}
        >
          {workers.map((w) => (
            <option key={`wopt-${w.id}`} value={w.id}>{w.nombre}</option>
          ))}
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
        <button
          style={disabledIf(btnPrimary, locked)}
          disabled={locked}
          onClick={crearBloque}
        >
          ➕ Planificar
        </button>
      </div>
    </div>
  )}
</div>


            <div style={panel}>
  <div
    style={{ ...panelTitle, ...collapsibleHeader }}
    onClick={() => setIsWorkersOpen(v => !v)}
    aria-expanded={isWorkersOpen}
  >
    <span>Trabajadores</span>
    <span style={caret}>{isWorkersOpen ? "▾" : "▸"}</span>
  </div>

  {isWorkersOpen && (
    <>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <input
          style={disabledIf(input, locked)}
          disabled={locked}
          placeholder="Nombre del trabajador"
          value={nuevoTrabajador}
          onChange={(e) => setNuevoTrabajador(e.target.value)}
        />
        <button
          style={disabledIf(btnLabeled, locked)}
          disabled={locked}
          onClick={addWorker}
        >
          ➕ Añadir
        </button>
      </div>

      <table style={table}>
        <thead>
          <tr>
            <th style={th}>Nombre</th>
            <th style={th}>L</th>
            <th style={th}>M</th>
            <th style={th}>X</th>
            <th style={th}>J</th>
            <th style={th}>V</th>
            <th style={th}>Acciones</th>
          </tr>
        </thead>
        <tbody>
          {workers.map((w) => (
            <tr key={`row-${w.id}`}>
              <td style={td}>
                <input
                  style={disabledIf(input, locked)}
                  disabled={locked}
                  value={w.nombre}
                  onChange={(e) => editWorker(w.id, { nombre: e.target.value })}
                />
              </td>

              {(["lu","ma","mi","ju","vi"] as const).map((dia) => (
                <td key={`${w.id}-${dia}`} style={td}>
                  <input
                    style={disabledIf(input, locked)}
                    disabled={locked}
                    type="number"
                    min={0}
                    step={0.5}
                    value={w.jornada[dia]}
                    onChange={(e) => {
                      const v = Math.max(0, Number(e.target.value));
                      setWorkers(prev => prev.map(x =>
                        x.id === w.id ? { ...x, jornada: { ...x.jornada, [dia]: v } } : x
                      ));
                    }}
                  />
                </td>
              ))}

              <td style={{ ...td, width: 1, whiteSpace: "nowrap" }}>
                <button
                  style={disabledIf(btnTinyDanger, locked)}
                  disabled={locked}
                  onClick={() => deleteWorker(w.id)}
                  title="Eliminar trabajador y todas sus asignaciones"
                >
                  🗑 Eliminar
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ fontSize: 18, color: "#000000ff", marginTop: 6 }}>
        {locked
          ? "Bloqueado: solo lectura."
          : <>Doble clic en una <b>celda</b> para fijar <b>extras/sábado</b> de ese <b>día</b>. Botón <b>＋</b> inserta un bloque desde ese día.</>}
     
             </div>    </>  )}
            </div>
          </div>

          {/* CABECERA DÍAS (impresión mensual) */}
          <div style={daysHeader} className={printMode === "monthly" ? "" : "no-print"}>
  <div style={{ padding: "6px 8px", fontWeight: 600 }}>Sem</div>
  {weekDaysHeader.map((d, i) => (
    <div key={`dow-${i}`} style={{ padding: "6px 8px", fontWeight: 600 }}>{d}</div>
  ))}
</div>


          {/* CALENDARIO */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }} className={printMode === "monthly" ? "" : "no-print"}>
            {workers.map((w) => (
              <div key={`worker-${w.id}`}>
                <div style={{ fontSize: 25, fontWeight: 700, margin: "8px 0 4px", color: "#111827" }}>👤 {w.nombre}</div>

                {weeks.map((week) => (
                  <div key={`${w.id}-wk-${week[0].toISOString()}`} style={weekRow}>
                    <div style={weekCol}>{format(week[0], "I")}</div>
                    {week.map((d) => {
                      const f = fmt(d);
                      const iso = f || toLocalISO(d);
                      const delDia = f ? slices.filter((s) => s.trabajadorId === w.id && s.fecha === f) : [];
                      const cap = capacidadDia(w, d, overrides);
                      const used = usadasEnDia(slices, w.id, d);
                      const over = used > cap + 1e-9; // "over" significa "se pasó"
                      const ow: DayOverride = (overrides[w.id]?.[iso]) ?? {};
                          const dow = getDay(d); // 0=domingo, 6=sábado

                           
const handleDayHeaderDblClick = () => {
  if (!canEdit) return;

  // Usaremos el estado actual para construir el siguiente
  const prev = overrides;

  if (dow === 6) {
    // === SÁBADO ===
    const v = prompt("¿Trabaja el sábado " + iso + " ? (sí=1 / no=0)", (ow?.sabado ? "1" : "0"));
    if (v === null) return;
    const on = v.trim() === "1";

    // 1) Construye el OV nuevo
    const next: OverridesState = (() => {
      const byW = { ...(prev[w.id] || {}) };
      const cur = { ...(byW[iso] || {}) };
      if (on) cur.sabado = true; else delete cur.sabado;

      if (!cur.extra && !cur.sabado && !cur.domingo && !cur.vacacion) {
        delete byW[iso];
      } else {
        byW[iso] = cur;
      }
      return { ...prev, [w.id]: byW };
    })();

    // 2) Aplica y refluye con el OV NUEVO
    setOverrides(next);
    reflowFromWorkerWithOverrides(w.id, iso, next);
    compactarBloques(w.id);
  }
  else if (dow === 0) {
    // === DOMINGO ===
    const v = prompt("¿Trabaja el domingo " + iso + " ? (sí=1 / no=0)", (ow?.domingo ? "1" : "0"));
    if (v === null) return;
    const on = v.trim() === "1";

    const next: OverridesState = (() => {
      const byW = { ...(prev[w.id] || {}) };
      const cur = { ...(byW[iso] || {}) };
      if (on) cur.domingo = true; else delete cur.domingo;

      if (!cur.extra && !cur.sabado && !cur.domingo && !cur.vacacion) {
        delete byW[iso];
      } else {
        byW[iso] = cur;
      }
      return { ...prev, [w.id]: byW };
    })();

    setOverrides(next);
    reflowFromWorkerWithOverrides(w.id, iso, next);
    compactarBloques(w.id);
  }
};



                      const isVacation = !!((overrides[w.id] || {})[iso]?.vacacion);

                      return (
                        <div
                          style={{
                            ...dayCell,
                            ...(over
                            ? {
                                boxShadow: "inset 0 0 0 2px #dc2626", // borde rojo
                                background: "#fff5f5",               // fondo rosado claro
                               }
                           : {}),
                          }}
                          title={`Doble clic: extras / sábado / domingo para ${w.nombre} el ${f || "día"}`}

                          onDoubleClick={() => canEdit && editOverrideForDay(w, d)}
                          onDragOver={onDragOver}
                          onDrop={(e) => onDropDay(e, w.id, d)}
                        >
                          {/* Cabecera del día: número + avisos + botón ＋ */}
<div
  style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
  onDoubleClick={(e) => { e.stopPropagation(); handleDayHeaderDblClick(); }}
>
    
  <div>
  <span style={dayNumber}>{format(d, "d")}</span>{" "}
   
  {/* Avisos */}
  {ow ? (
    <>
      {ow.vacacion && <span style={dayWarn}>VACACIONES</span>}
      {!ow.vacacion && getDay(d) !== 6 && ow.extra && Number(ow.extra) > 0 && (
        <span style={dayWarn}>+{ow.extra} h extra</span>
      )}
      {!ow.vacacion && getDay(d) === 6 && ow.sabado && (
        <span style={dayWarn}>Sábado ON</span>
      )}
      {!ow.vacacion && getDay(d) === 0 && ow.domingo && (
        <span style={dayWarn}>Domingo ON</span>
      )}
    </>
  ) : null}
</div>

  {/* Botón + para insertar manual */}
  {canEdit && !isVacation && (
  <button className="no-print" onClick={() => addManualHere(w, d)} style={smallPlusBtn} title="Insertar manual aquí">
    ＋
  </button>
)}
</div>

                          <div style={horizontalLane}>
  {isVacation ? (
    // Bloque fijo de VACACIONES
    <div style={vacationBlock} title="Vacaciones (bloque fijo)">
      VACACIONES
      {canEdit && (
        <button
          onClick={() => borrarVacacionUnDia(w.id, iso)}
          style={vacDeleteBtn}
          title="Eliminar vacaciones de este día"
        >
          🗑
        </button>
      )}
    </div>
  ) : (
    // === TU BLOQUE ORIGINAL (sin cambios) ===
    delDia.map((s) => {
      const desc = descs[s.producto];
      const isUrgent =
        s.color === URGENT_COLOR ||
        /^⚠️/.test(s.producto) ||
        /urgenc/i.test(s.producto);

      return (
        <div
          key={s.id}
          draggable={canEdit}
          onDragStart={(e) => onDragStart(e, s.id)}
          onDoubleClick={(e) => {
  e.stopPropagation();
  if (!canEdit) return;

  const isUrgent =
    s.color === URGENT_COLOR ||
    /^⚠️/.test(s.producto) ||
    /urgenc/i.test(s.producto);

  if (isUrgent) {
    editUrgentSlice(s);   // ← no replanifica ni cambia de día
  } else {
    editBlockTotalFromSlice(s); // comportamiento normal
  }
}}

          title={`${s.producto} — ${s.horas}h${desc ? "\n" + desc : ""}`}
          style={{
            ...blockStyle,
            background: isUrgent ? URGENT_COLOR : s.color,
            width: Math.max(18, s.horas * PX_PER_HOUR),
            position: "relative",
          }}
        >
          {canEdit && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); removeSlice(s.id); }}
                title="Eliminar tramo"
                style={deleteBtn}
              >
                ✖
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); removeTask(s.taskId, s.trabajadorId); }}
                title="Eliminar bloque completo"
                style={deleteBtnAlt}
              >
                🗑
              </button>
            </>
          )}

          <div style={blockTop}>
            
  <span style={productFull}>
    {s.producto}
  </span>
  <span>{s.horas}h</span>
</div>

          {desc ? <div style={miniHint}>ⓘ</div> : null}
        </div>
      );
    })
  )}
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
                   
        </div>

        {/* SIDEBAR */}
        <aside style={sidebar} className="no-print">
          {/* === Panel: Actualizar día trabajador === */}
<div style={{ ...panel, marginBottom: 14 }}>
  <div style={panelTitle}>Actualizar día trabajador</div>

  <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
    <button
      style={disabledIf(btnLabeled, locked)}
      disabled={locked}
      onClick={() => setUpdOpen(v => !v)}
    >
      {updOpen ? "Cerrar" : "Abrir"} panel
    </button>
  </div>

  {updOpen && (
    <div style={{ display: "grid", gap: 8 }}>
      <label style={label}>Trabajador</label>
      <select
        style={disabledIf(input, locked)}
        disabled={locked}
        value={updWorker}
        onChange={(e) => setUpdWorker(e.target.value)}
      >
        {workers.map(w => (
          <option key={`upd-w-${w.id}`} value={w.id}>{w.nombre}</option>
        ))}
      </select>

      <label style={label}>Día</label>
      <input
        type="date"
        style={disabledIf(input, locked)}
        disabled={locked}
        value={updDate}
        onChange={(e) => setUpdDate(e.target.value)}
      />

      <div style={{ marginTop: 6, fontWeight: 700 }}>Bloques de ese día</div>

      {updMatches.length === 0 ? (
        <div style={{ fontSize: 12, color: "#6b7280" }}>
          No hay bloques ese día para este trabajador.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {updMatches.map((m, idx) => (
            <div key={`upd-m-${m.taskId}-${idx}`} style={descItem}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 700 }}>{m.producto}</div>
                <div style={{ fontSize: 12, color: "#374151" }}>Hoy: {m.horasHoy}h</div>
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <input
                  type="number"
                  step={0.5}
                  min={0.5}
                  placeholder="Horas reales hoy"
                  style={disabledIf(input, locked)}
                  disabled={locked}
                  onKeyDown={(e) => {
                    // Enter rápido
                    if (e.key === "Enter") {
                      const val = Number((e.target as HTMLInputElement).value);
                      updateBlockHoursForDay(m.taskId, updWorker, updDate, val);
                    }
                  }}
                />
                <button
                  style={disabledIf(btnPrimary, locked)}
                  disabled={locked}
                  onClick={(ev) => {
                    // toma el input anterior
                    const container = (ev.currentTarget.parentElement as HTMLElement);
                    const input = container.querySelector("input") as HTMLInputElement | null;
                    const val = input ? Number(input.value) : m.horasHoy;
                    updateBlockHoursForDay(m.taskId, updWorker, updDate, val);
                  }}
                >
                  💾 Guardar horas de hoy
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 6, fontWeight: 700 }}>Añadir incidencia (bloque nuevo)</div>
      <input
        style={disabledIf(input, locked)}
        disabled={locked}
        placeholder="Nombre del producto / incidencia"
        value={updNewProd}
        onChange={(e) => setUpdNewProd(e.target.value)}
      />
      <input
        type="number"
        step={0.5}
        min={0.5}
        style={disabledIf(input, locked)}
        disabled={locked}
        placeholder="Horas totales"
        value={updNewHoras}
        onChange={(e) => setUpdNewHoras(Number(e.target.value))}
      />
      <button
        style={disabledIf(btnLabeled, locked)}
        disabled={locked || !updNewProd.trim()}
        onClick={() => {
          addNewBlockFromDay(updWorker, updDate, updNewProd, updNewHoras);
          setUpdNewProd("");
          setUpdNewHoras(1);
        }}
      >
        ➕ Añadir bloque desde este día
      </button>

      <div style={{ fontSize: 12, color: "#6b7280" }}>
        Nota: al cambiar “horas de hoy” se fija ese día y el resto del bloque se replanifica desde el día siguiente.
      </div>
    </div>
  )}
</div>

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
              <div key={`desc-${prod}`} style={descItem}>
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
                {workers.map(w=><option key={`ebw-${w.id}`} value={w.id}>{w.nombre}</option>)}
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
                      <option key={`ebmatch-${m.taskId}`} value={m.taskId}>
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
          {/* === Copias de seguridad === */}
<div style={{ ...panel, marginTop: 14 }}>
  <div style={panelTitle}>Copias de seguridad</div>
  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
    <button
      style={disabledIf(btnLabeled, false)}
      onClick={() => {
        const key = saveBackup("manual");
        if (key) alert("Copia guardada correctamente.");
      }}
    >
      💾 Guardar copia ahora
    </button>
    <button
      style={disabledIf(btnLabeled, false)}
      onClick={restoreLastBackup}
    >
      ⤴️ Restaurar última
    </button>
    <button
      style={disabledIf(btnLabeled, false)}
      onClick={downloadLastBackup}
    >
      ⬇️ Exportar última (.json)
    </button>
  </div>
  {/* === BOTONES DE COPIA EN LA NUBE (SUPABASE) === */}
{userId && (
  <div
    style={{
      display: "flex",
      gap: 8,
      flexWrap: "wrap",
      marginTop: 8,
    }}
  >
    <button
      style={disabledIf(btnLabeled, false)}
      onClick={saveCloudBackup}
    >
      ☁️ Guardar en la nube
    </button>

    <button
      style={disabledIf(btnLabeled, false)}
      onClick={restoreLatestCloudBackup}
    >
      ☁️ Restaurar última de la nube
    </button>
  </div>
)}

  <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>
    Se guarda automáticamente al iniciar, cada 10 minutos y al ocultar la pestaña. Mantengo hasta {MAX_BACKUPS} copias.
  </div>
</div>

{/* === Gestión masiva: extras / vacaciones / domingos === */}
<div style={{ ...panel, marginTop: 14 }}>
  <div style={panelTitle}>Gestión masiva</div>

  <div style={{ display: "grid", gap: 8 }}>
    <label style={label}>Trabajador</label>
    <select style={input} value={gmWorker} onChange={(e)=>setGmWorker(e.target.value)}>
      {workers.map(w => <option key={`gmw-${w.id}`} value={w.id}>{w.nombre}</option>)}
    </select>

    <label style={label}>Desde</label>
    <input type="date" style={input} value={gmFrom} onChange={(e)=>setGmFrom(e.target.value)} />

    <label style={label}>Hasta</label>
    <input type="date" style={input} value={gmTo} onChange={(e)=>setGmTo(e.target.value)} />

    <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginTop: 6 }}>
      {/* EXTRAS */}
      <input
        type="number"
        step={0.5}
        min={0}
        placeholder="Horas extra/día"
        style={{ ...input, width: 160 }}
        value={gmExtra}
        onChange={(e)=>setGmExtra(Number(e.target.value))}
      />
      <button style={btnLabeled} onClick={aplicarExtrasRango}>➕ Aplicar extras</button>

      {/* VACACIONES */}
      <button style={btnLabeled} onClick={marcarVacacionesRango}>🏖️ Marcar vacaciones</button>
      <button style={btnTiny} onClick={borrarVacacionesRango}>🗑 Quitar vacaciones</button>

        </div>

    <div style={{ fontSize: 12, color: "#6b7280" }}>
      Nota: las <b>vacaciones</b> generan un bloque fijo en los días seleccionados. No se pueden añadir bloques esos días, pero puedes <b>borrar</b> las vacaciones con el botón.
    </div>
  </div>
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

function RTBadge({ status }: { status: RTStatus }) {
  const color =
    status === "connected" ? "#10b981" : // verde
    status === "connecting" ? "#f59e0b" : // ámbar
    "#ef4444"; // rojo

  const label =
    status === "connected" ? "Realtime: conectado" :
    status === "connecting" ? "Realtime: reconectando…" :
    "Realtime: error de conexión";

  return (
    <div title={label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        style={{
          width: 10, height: 10, borderRadius: "50%",
          background: color, boxShadow: "0 0 0 2px rgba(255,255,255,.2)"
        }}
      />
      <span style={{ color: "#e5e7eb", fontSize: 12 }}>{label}</span>
    </div>
  );
}



/* ===================== Badge ===================== */
function DayCapacityBadge({ capacidad, usado }: { capacidad: number; usado: number }) {
  const libre = Math.round((capacidad - usado) * 10) / 10;
  const exceso = Math.round((usado - capacidad) * 10) / 10; // si > 0, hay sobrecarga

  const base: React.CSSProperties = { marginTop: 6, fontSize: 11, color: "#374151" };

  return (
    <div style={base}>
      Cap: {capacidad.toFixed(1)}h · Usado: {usado.toFixed(1)}h · Libre:{" "}
      <span style={{ fontWeight: 700 }}>{Math.max(0, libre).toFixed(1)}h</span>

      {exceso > 0 && (
        <div
          style={{
            marginTop: 4,
            fontSize: 12,
            fontWeight: 700,
            color: "#b91c1c",        // rojo
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
          title="Este día tiene más horas asignadas que su capacidad"
        >
          ⚠️ Sobreasignado: +{exceso.toFixed(1)}h
        </div>
      )}
    </div>
  );
}

/* ===================== Estilos ===================== */
const appShell: React.CSSProperties = {
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  background: "#62bfe7ff",
  minHeight: "100vh",
};

// === Bloque de vacaciones ===
const vacationBlock: React.CSSProperties = {
  height: 28,
  borderRadius: 8,
  background: "#fde68a",
  border: "1px solid #f59e0b",
  color: "#92400e",
  fontWeight: 800,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0 8px",
  userSelect: "none",
};

// === Botón eliminar vacaciones ===
const vacDeleteBtn: React.CSSProperties = {
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: "#7c2d12",
  fontSize: 14,
};


const topHeader: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 50,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 16px",
  background: "#1f2937",
  borderBottom: "1px solid rgba(255,255,255,.15)",
};

const appTitle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
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

// === Estilos del número de día y avisos ===
const dayNumber: React.CSSProperties = {
  fontSize: 24,        // tamaño del número del día (puedes subir a 26 o 28)
  fontWeight: 900,
  color: "#111827",
  lineHeight: 1,
};

const dayWarn: React.CSSProperties = {
  fontSize: 12,
  color: "#d81327",
  fontWeight: 700,
  marginLeft: 6,
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
// Encabezados desplegables
const collapsibleHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  cursor: "pointer",
  userSelect: "none",
};
const caret: React.CSSProperties = { opacity: 0.7, marginLeft: 8, fontWeight: 700 };

const grid2: React.CSSProperties = { display: "grid", gap: 8, gridTemplateColumns: "180px 1fr", alignItems: "center" };
const label: React.CSSProperties = { fontSize: 13, color: "#374151" };
const input: React.CSSProperties = { padding: "8px 10px", border: "1px solid #e5e7eb", borderRadius: 8, outline: "none", width: "100%", boxSizing: "border-box" };
const textarea: React.CSSProperties = { ...input, minHeight: 100, resize: "vertical" as const };

const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 13, background: "#fff" };
const th: React.CSSProperties = { textAlign: "left", borderBottom: "1px solid #e5e7eb", padding: "6px", background: "#f9fafb" };
const td: React.CSSProperties = { borderBottom: "1px solid #f3f4f6", padding: "6px" };

const daysHeader: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "56px repeat(7, 1fr)", // ⬅️ antes era "repeat(7, 1fr)"
  gap: 2,
  fontSize: 12,
  margin: "8px 0 4px",
  color: "#000000ff",
};

const weekRow: React.CSSProperties = { display: "grid", gridTemplateColumns: "56px repeat(7, 1fr)", gap: 2, marginBottom: 2 };
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

const weekCol: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontWeight: 800,
  color: "#111827",
  background: "#f9fafb",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  minHeight: 130 // igual que dayCell.minHeight para que alinee
};

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
