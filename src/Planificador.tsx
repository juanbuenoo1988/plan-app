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
// === Tipos para Partes de trabajo ===
type ParteTrabajo = {
  id?: string;
  fecha: string;          // YYYY-MM-DD
  trabajadorId: string;
  producto: string;       // clave/descripcion seleccionada
  horasReales: number;
  observaciones: string;
};
// === Parte de trabajo (para guardar en nube/BD/JSON) ===
type WorkPartPayload = {
  user_id: string;
  tenant_id: string;
  fecha: string;                 // YYYY-MM-DD
  trabajador_id: string;
  trabajador_nombre: string;
  producto: string;              // nombre del bloque/“producto”
  horas_reales: number;          // horas reales trabajadas
  observaciones: string;
  created_at: string;            // ISO
  storage_path?: string;         // ruta de storage donde se guardó el JSON
};

type ParteItem = {
  producto: string;        // p.ej. "OT-250033"
  horas_reales: number;    // p.ej. 6.5
  observaciones?: string;  // opcional
};

type PartesPorTrabajador = Record<string, ParteItem[]>;

type ParteResumenTrabajador = {
  trabajador_id: string;
  trabajador_nombre: string;
  items: ParteItem[];
  total_horas: number;
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

  function buscarYSeleccionarBloqueParte() {
  const q = (parteQuery || "").trim().toLowerCase();
  if (!q) {
    alert("Escribe algo en 'Buscar bloque'.");
    return;
  }

  // 1) Coincidencia exacta primero
  const exact = productosFiltrados.find(p => p.toLowerCase() === q);
  if (exact) {
    setParteProducto(exact);
    return;
  }

  // 2) Primera coincidencia parcial
  const parcial = productosFiltrados.find(p => p.toLowerCase().includes(q));
  if (parcial) {
    setParteProducto(parcial);
    return;
  }

  alert("No se encontraron bloques que coincidan.");
}

function generarVentanaPDFParte(fecha: string, trabajadorNombre: string, items: ParteItem[]) {
  const total = items.reduce((a, it) => a + (Number(it.horas_reales)||0), 0);

  const html = `<!doctype html>
<html><head><meta charset="utf-8" />
<title>Parte ${fecha} - ${trabajadorNombre}</title>
<style>
body{font-family: Arial, sans-serif; padding:24px; color:#111827}
h1{margin:0 0 6px 0; font-size:20px}
.sub{color:#6b7280; margin-bottom:16px}
table{width:100%; border-collapse:collapse}
th,td{border-bottom:1px solid #e5e7eb; padding:8px; text-align:left}
th{background:#f9fafb}
.right{text-align:right}
.tot{font-weight:700}
.obs{white-space:pre-wrap; color:#374151}
@page { size: auto; margin: 15mm; }
</style></head>
<body>
<h1>Parte de trabajo</h1>
<div class="sub">Fecha: <b>${fecha}</b> &nbsp;|&nbsp; Trabajador: <b>${trabajadorNombre}</b></div>
<table>
<thead><tr><th>Descripción / bloque</th><th class="right">Horas</th><th>Observaciones</th></tr></thead>
<tbody>
${items.map(it => `
<tr>
  <td>${it.producto}</td>
  <td class="right">${it.horas_reales}</td>
  <td class="obs">${it.observaciones || ""}</td>
</tr>`).join("")}
</tbody>
<tfoot>
<tr><td class="tot">TOTAL</td><td class="right tot">${total}</td><td></td></tr>
</tfoot>
</table>
<script>
  // Abre diálogo de impresión al cargar (elige "Guardar como PDF")
  window.onload = function(){ window.print(); };
</script>
</body></html>`;

  const wwin = window.open("", "_blank");
  if (!wwin) {
    alert("Permite la ventana emergente para descargar/imprimir el PDF.");
    return;
  }
  wwin.document.open();
  wwin.document.write(html);
  wwin.document.close();
  wwin.focus();
}

function generarVentanaPDFParteTaller(fecha: string, resumen: ParteResumenTrabajador[]) {
  const totalTaller = resumen.reduce((a, r) => a + (Number(r.total_horas) || 0), 0);

  const seccionesHTML = resumen.map(r => {
    const filas = r.items.map(it => `
      <tr>
        <td>${it.producto}</td>
        <td class="right">${it.horas_reales}</td>
        <td class="obs">${it.observaciones || ""}</td>
      </tr>
    `).join("");

    return `
      <h2 style="margin: 24px 0 6px 0; font-size:16px">👤 ${r.trabajador_nombre}</h2>
      <table>
        <thead><tr><th>Descripción / bloque</th><th class="right">Horas</th><th>Observaciones</th></tr></thead>
        <tbody>${filas || `<tr><td colspan="3" style="color:#6b7280">— Sin líneas —</td></tr>`}</tbody>
        <tfoot><tr><td class="tot">Subtotal ${r.trabajador_nombre}</td><td class="right tot">${r.total_horas}</td><td></td></tr></tfoot>
      </table>
    `;
  }).join("");

  const html = `<!doctype html>
<html><head><meta charset="utf-8" />
<title>Parte Taller ${fecha}</title>
<style>
body{font-family: Arial, sans-serif; padding:24px; color:#111827}
h1{margin:0 0 6px 0; font-size:20px}
.sub{color:#6b7280; margin-bottom:16px}
table{width:100%; border-collapse:collapse; margin-top:8px}
th,td{border-bottom:1px solid #e5e7eb; padding:8px; text-align:left}
th{background:#f9fafb}
.right{text-align:right}
.tot{font-weight:700}
.obs{white-space:pre-wrap; color:#374151}
@page { size: auto; margin: 15mm; }
</style></head>
<body>
<h1>Parte de trabajo — Taller completo</h1>
<div class="sub">Fecha: <b>${fecha}</b></div>

${seccionesHTML}

<hr style="margin:24px 0" />
<h2 style="margin:0 0 6px 0">TOTAL HORAS TALLER: ${totalTaller}</h2>

<script>
  // Abre el diálogo de impresión automáticamente (elige "Guardar como PDF")
  window.onload = function(){ window.print(); };
</script>
</body></html>`;

  const wwin = window.open("", "_blank");
  if (!wwin) {
    alert("Permite la ventana emergente para descargar/imprimir el PDF.");
    return;
  }
  wwin.document.open();
  wwin.document.write(html);
  wwin.document.close();
  wwin.focus();
}

/**
 * Ajusta el calendario con las horas reales introducidas en un PARTE para una fecha dada.
 * - Solo toca los slices del mismo trabajador y producto.
 * - Ajusta exactamente las horas del día a las horas reales (“objetivo”).
 * - Si sobran/faltan horas, compensa con los días futuros del mismo bloque.
 * - Recompacta SOLO desde esa fecha para ese trabajador.
 */
function aplicarResumenAlCalendario(fechaStr: string, resumen: ParteResumenTrabajador[]) {
  const fecha = new Date(fechaStr);
  if (isNaN(fecha.getTime?.() ?? NaN)) return;

  setSlices((prevAll) => {
    let next = [...prevAll];

    for (const r of resumen) {
      const workerId = r.trabajador_id;

      // Trabajamos por producto (sumando líneas repetidas)
      const horasPorProducto = new Map<string, number>();
      for (const it of r.items) {
        const h = Number(it.horas_reales) || 0;
        if (h <= 0) continue;
        horasPorProducto.set(it.producto, Math.round(((horasPorProducto.get(it.producto) || 0) + h) * 2) / 2);
      }

      // Si no hay líneas válidas, no tocamos nada
      if (horasPorProducto.size === 0) continue;

      for (const [producto, horasObjetivo] of horasPorProducto.entries()) {
        // 1) Slices del día y del futuro para este worker+producto
        const f = fmt(fecha);
        const delDia = next.filter(s => s.trabajadorId === workerId && s.producto === producto && s.fecha === f);
        const futuros = next
          .filter(s => s.trabajadorId === workerId && s.producto === producto && s.fecha! > f!)
          .sort((a, b) => a.fecha.localeCompare(b.fecha));

        const asignadoHoy = delDia.reduce((a, s) => a + s.horas, 0);
        const delta = Math.round((horasObjetivo - asignadoHoy) * 2) / 2;

        // 2) Si ya coincide, no hacemos nada
        if (Math.abs(delta) < 1e-9) continue;

        // 3) Asegura que existe al menos 1 slice para hoy (creamos uno si hace falta)
        let daySlices = delDia;
        if (daySlices.length === 0) {
          // generamos un slice nuevo TOMANDO el color/taskId de un futuro si existe, o uno nuevo
          let baseTaskId = "T" + Math.random().toString(36).slice(2, 8);
          let baseColor = colorFromId(baseTaskId);
          if (futuros.length > 0) {
            baseTaskId = futuros[0].taskId;
            baseColor = futuros[0].color;
          }
          daySlices = [{
            id: "S" + Math.random().toString(36).slice(2, 9),
            taskId: baseTaskId,
            producto,
            fecha: f!,
            horas: 0,
            trabajadorId: workerId,
            color: baseColor,
          }];
          next.push(daySlices[0]);
        }

        // 4) Ajusta hoy al objetivo, tomando/soltando horas de los futuros del MISMO producto
        if (delta > 0) {
          // Falta horas hoy → traer desde el futuro
          let resta = delta;
          for (const fs of futuros) {
            if (resta <= 0) break;
            const take = Math.min(fs.horas, resta);
            if (take > 0) {
              fs.horas = Math.round((fs.horas - take) * 2) / 2;
              // las añadimos a hoy (al primer slice del día)
              daySlices[0].horas = Math.round((daySlices[0].horas + take) * 2) / 2;
              resta = Math.round((resta - take) * 2) / 2;
            }
          }
          // Si aún resta (>0) y no hay más futuro, igualmente fijamos hoy al máximo posible
          // (esto respeta que no podemos "inventar" horas futuras).
        } else {
          // delta < 0 → sobra horas hoy → devolver al futuro (al primer día futuro del mismo bloque)
          let sobra = -delta;
          // Si no hay futuro, creamos un slice futuro al día siguiente para devolver esas horas
          let targetFuture = futuros[0];
          if (!targetFuture) {
            targetFuture = {
              id: "S" + Math.random().toString(36).slice(2, 9),
              taskId: daySlices[0].taskId,
              producto,
              fecha: fmt(addDays(fecha, 1))!,
              horas: 0,
              trabajadorId: workerId,
              color: daySlices[0].color,
            };
            next.push(targetFuture);
          }
          // Quitamos de hoy
          const reduceFrom = daySlices.reduce((a, s) => a + s.horas, 0);
          const toReduce = Math.min(reduceFrom, sobra);
          if (toReduce > 0) {
            // Reducimos solo del primer slice del día (simplifica mucho)
            daySlices[0].horas = Math.max(0, Math.round((daySlices[0].horas - toReduce) * 2) / 2);
            targetFuture.horas = Math.round((targetFuture.horas + toReduce) * 2) / 2;
            sobra = Math.round((sobra - toReduce) * 2) / 2;
          }
        }

        // 5) Limpieza: elimina futuros con 0h del mismo producto/worker
        next = next.filter(s => !(s.trabajadorId === workerId && s.producto === producto && s.fecha! > f! && s.horas <= 0));

        // 6) Compacta SOLO al trabajador afectado desde esa fecha
        const worker = workers.find(w => w.id === workerId);
        if (worker) {
          const otros = next.filter(s => s.trabajadorId !== workerId);
          const delWorker = next.filter(s => s.trabajadorId === workerId);

          const keepBefore = delWorker.filter(s => s.fecha < f!);
          const tail = delWorker.filter(s => s.fecha >= f!);

          // Reagrupar la cola de tail por taskId manteniendo producto/color
          const queue = aggregateToQueue(tail);
          const reflowed = reflowFrom(worker, fecha, overrides, keepBefore, queue);

          next = [...otros, ...reflowed];
        }
      }
    }

    // Seguridad: no dejes “valores negativos” por error
    for (const s of next) {
      if (s.horas < 0) s.horas = 0;
    }
    return next;
  });
}


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
    // ====== Partes de trabajo (UI y datos) ======
  const [showPartes, setShowPartes] = useState<boolean>(false);
  const [parteFecha, setParteFecha] = useState<string>(fmt(new Date()));
  const [parteTrabajador, setParteTrabajador] = useState<string>("W1");
  const [parteQuery, setParteQuery] = useState<string>("");
  const [parteProducto, setParteProducto] = useState<string>("");
  const [parteHoras, setParteHoras] = useState<number>(0);
  const [parteObs, setParteObs] = useState<string>("");
  const [partePorTrabajador, setPartePorTrabajador] = useState<PartesPorTrabajador>({});
  const hayLineasEnAlguno = useMemo(() => {
  return Object.values(partePorTrabajador).some(arr => (arr?.length ?? 0) > 0);
}, [partePorTrabajador]);
// Total por trabajador
  const totalesPorTrabajador = useMemo(() => {
  const map: Record<string, number> = {};
  for (const [wid, items] of Object.entries(partePorTrabajador)) {
    map[wid] = items.reduce((a, it) => a + (Number(it.horas_reales) || 0), 0);
  }
  return map;
}, [partePorTrabajador]);

// Total general del taller (suma de todos)
const totalTaller = useMemo(
  () => Object.values(totalesPorTrabajador).reduce((a, n) => a + n, 0),
  [totalesPorTrabajador]
);

  const [savingParte, setSavingParte] = useState<boolean>(false);
  const [parteMsg, setParteMsg] = useState<string | null>(null);

  // Si el trabajador actual no está en el objeto, lo creamos (para que aparezca su bloque vacío)
useEffect(() => {
  setPartePorTrabajador(prev => {
    if (prev[parteTrabajador]) return prev;
    return { ...prev, [parteTrabajador]: [] };
  });
}, [parteTrabajador]);



  // Productos/bloques disponibles (del calendario) para ese trabajador y día
  const productosDisponibles = useMemo(() => {
    const set = new Set<string>();
    const f = parteFecha;
    const w = parteTrabajador;
    slices.forEach(s => {
      if (s.trabajadorId === w && (!f || s.fecha === f)) set.add(s.producto);
    });
    return Array.from(set).sort((a,b)=>a.localeCompare(b));
  }, [slices, parteFecha, parteTrabajador]);

  // Filtro buscador
  const productosFiltrados = useMemo(() => {
  const set = new Set<string>();
  // toma TODOS los slices (sin filtrar por trabajador)
  slices.forEach(s => {
    const name = (s.producto || "").trim();
    if (name) set.add(name);
  });
  const all = [...set].sort((a, b) => a.localeCompare(b, "es"));
  const q = (parteQuery || "").trim().toLowerCase();
  return q ? all.filter(p => p.toLowerCase().includes(q)) : all;
}, [slices, parteQuery]);


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
    // Al cambiar el trabajador del formulario, sube suavemente al inicio
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
      return [...restantes, ...plan];
    });
  }
function agregarLineaParte() {
  if (!parteProducto) { alert("Elige la descripción/bloque."); return; }
  if (!isFinite(parteHoras) || Number(parteHoras) <= 0) { alert("Horas reales inválidas."); return; }

  const item: ParteItem = {
    producto: parteProducto,
    horas_reales: Math.round(Number(parteHoras) * 2) / 2,
    observaciones: parteObs.trim() || undefined,
  };

  setPartePorTrabajador(prev => {
    const arr = prev[parteTrabajador] ?? [];
    return { ...prev, [parteTrabajador]: [...arr, item] };
  });

  // limpia campos para meter otra línea
  setParteProducto("");
  setParteHoras(0);
  setParteObs("");
}

function eliminarLineaParteDe(wid: string, idx: number) {
  setPartePorTrabajador(prev => {
    const arr = prev[wid] ?? [];
    return { ...prev, [wid]: arr.filter((_, i) => i !== idx) };
  });
}

    // Guardar parte de trabajo: sube un JSON a Storage y registra fila en BD

   async function guardarParteTrabajo() {
  // Ya NO exigimos estar logueado: se puede imprimir sin guardar en BD
  const f = parteFecha;
  if (!f) { alert("Elige una fecha."); return; }

  // 1) Construye un objeto por trabajador a partir de la UI
  const porTrab: PartesPorTrabajador =
    typeof structuredClone === "function"
      ? structuredClone(partePorTrabajador)
      : JSON.parse(JSON.stringify(partePorTrabajador || {}));

  // Si no hay líneas acumuladas y la línea rápida es válida, métela
  const lineaRapidaValida = parteProducto && isFinite(parteHoras) && Number(parteHoras) > 0;
  const hayLineasAcumuladas = Object.values(porTrab).some(arr => (arr?.length ?? 0) > 0);

  if (!hayLineasAcumuladas && lineaRapidaValida) {
    porTrab[parteTrabajador] = porTrab[parteTrabajador] ?? [];
    porTrab[parteTrabajador].push({
      producto: parteProducto,
      horas_reales: Math.round(Number(parteHoras) * 2) / 2,
      observaciones: (parteObs || "").trim() || undefined,
    });
  }

  // 2) Construye el RESUMEN por trabajador (nombre, items, subtotal)
  const resumen: ParteResumenTrabajador[] = Object.entries(porTrab)
    .map(([wid, items]) => {
      const w = workers.find(x => x.id === wid);
      const nombre = w?.nombre || wid;
      const total = items.reduce((a, it) => a + (Number(it.horas_reales) || 0), 0);
      return { trabajador_id: wid, trabajador_nombre: nombre, items, total_horas: total };
    })
    .filter(r => r.items.length > 0);

  if (resumen.length === 0) {
    alert("No hay líneas para guardar/imprimir.");
    return;
  }

  // 3) Actualiza el calendario con las horas reales (tu función ya creada)
  try {
    setSavingParte(true);
    setParteMsg("Ajustando calendario y generando PDF…");

    // 👉 Esta función la añadimos en pasos previos: ajusta slices y reprograma
    aplicarResumenAlCalendario(f, resumen);

    // 4) Abre la ventana de impresión del parte del taller (un único PDF)
    setTimeout(() => {
      generarVentanaPDFParteTaller(f, resumen);
    }, 50);

    // 5) Limpia la UI del parte
    setPartePorTrabajador({});
    setParteProducto("");
    setParteHoras(0);
    setParteObs("");
    setParteMsg("✅ Parte generado (descarga/imprime el PDF).");
  } catch (e: any) {
    setParteMsg(`⚠️ Error: ${e?.message ?? String(e)}`);
  } finally {
    setSavingParte(false);
  }
}

function printParteTaller() {
  // 1) Clona lo acumulado por trabajador
  const porTrab: PartesPorTrabajador =
    typeof structuredClone === "function"
      ? structuredClone(partePorTrabajador)
      : JSON.parse(JSON.stringify(partePorTrabajador || {}));

  // 2) Si no hay nada acumulado y la línea rápida es válida, métela en el trabajador seleccionado
  const lineaRapidaValida = parteProducto && isFinite(parteHoras) && Number(parteHoras) > 0;
  const hayLineasAcumuladas = Object.values(porTrab).some(arr => (arr?.length ?? 0) > 0);

  if (!hayLineasAcumuladas && lineaRapidaValida) {
    porTrab[parteTrabajador] = porTrab[parteTrabajador] ?? [];
    porTrab[parteTrabajador].push({
      producto: parteProducto,
      horas_reales: Math.round(Number(parteHoras) * 2) / 2,
      observaciones: (parteObs || "").trim() || undefined,
    });
  }

  // 3) Construye el resumen por trabajador (con subtotales)
  const resumen: ParteResumenTrabajador[] = Object.entries(porTrab)
    .map(([wid, items]) => {
      const w = workers.find(x => x.id === wid);
      const nombre = w?.nombre || wid;
      const total = items.reduce((a, it) => a + (Number(it.horas_reales) || 0), 0);
      return { trabajador_id: wid, trabajador_nombre: nombre, items, total_horas: total };
    })
    .filter(r => r.items.length > 0);

  if (resumen.length === 0) {
    alert("No hay líneas para imprimir.");
    return;
  }

  // 4) Llama al generador de PDF del taller
  generarVentanaPDFParteTaller(parteFecha, resumen);
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

        {/* Botón para abrir/cerrar la pestaña de Partes */}
    <button
      className="no-print"
      style={btnPrimary}
      onClick={() => setShowPartes(v => !v)}
      title="Crear un parte de trabajo"
    >
      📋 Partes de trabajo
    </button>

    {/* === UI de autenticación === */}
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
          {/* BARRA IMPRESIÓN */}
          <div style={bar} className="no-print">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button style={btnLabeled} onClick={() => triggerPrint("monthly")}>🖨️ Imprimir mensual</button>
              <select style={input} value={printWorker} onChange={(e) => setPrintWorker(e.target.value)}>
                {workers.map((w) => <option key={`op-${w.id}`} value={w.id}>{w.nombre}</option>)}
              </select>
              <input style={input} type="date" value={printDate} onChange={(e) => setPrintDate(e.target.value)} />
              <button style={btnLabeled} onClick={() => triggerPrint("daily")}>🖨️ Imprimir diario</button>
              <button style={btnPrimary} onClick={() => triggerPrint("dailyAll")}>🖨️ Imprimir diario (todos)</button>
            </div>
          </div>


                    {/* ====== Pestaña: Partes de trabajo ====== */}
          {showPartes && (
            <div
    style={{ ...panel, marginBottom: 12, width: "50%", minWidth: 520, margin: "0 auto" }}
    className="no-print"
  >
              <div style={panelTitle}>Partes de trabajo</div>
              <div style={{ display: "grid", gap: 10 }}>
                <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 8, alignItems: "center" }}>
                  <label style={label}>Día</label>
                  <input style={input} type="date" value={parteFecha} onChange={e=>setParteFecha(e.target.value)} />

                  <label style={label}>Trabajador</label>
                  <select style={input} value={parteTrabajador} onChange={e=>setParteTrabajador(e.target.value)}>
                    {workers.map(w => <option key={`p-w-${w.id}`} value={w.id}>{w.nombre}</option>)}
                  </select>


<label style={label}>Buscar bloque</label>
<div style={{ display: "flex", gap: 8 }}>
  <input
    style={input}
    placeholder="Escribe para filtrar por nombre del bloque/producto"
    value={parteQuery}
    onChange={e=>setParteQuery(e.target.value)}
  />
  <button
    type="button"
    style={btnLabeled}
    onClick={buscarYSeleccionarBloqueParte}
    title="Selecciona la primera coincidencia"
  >
    🔎 Buscar bloques
  </button>
</div>


                  <label style={label}>Descripción/bloque</label>
                  <select
                    style={input}
                    value={parteProducto}
                    onChange={e=>setParteProducto(e.target.value)}
                  >
                    <option value="">— elige —</option>
                    {productosFiltrados.map(p => (
                      <option key={`p-opt-${p}`} value={p}>{p}</option>
                    ))}
                  </select>

                  <label style={label}>Horas reales</label>
                  <input
                    style={input}
                    type="number"
                    min={0}
                    step={0.5}
                    value={parteHoras}
                    onChange={e=>setParteHoras(Number(e.target.value))}
                  />

                  <label style={label}>Observaciones</label>
                  <textarea
                    style={textarea}
                    rows={4}
                    placeholder="Incidencias, materiales, notas…"
                    value={parteObs}
                    onChange={e=>setParteObs(e.target.value)}
                      
/>
{/* === BLOQUE NUEVO: Añadir línea y listado === */}
<div style={{
    gridColumn: "1 / -1",               // usa todo el ancho del formulario
    display: "grid",
    gridTemplateColumns: "240px 1fr",   // 240px para la columna de botones, resto para la lista
    gap: 16,
    alignItems: "start",
    marginTop: 12,
  }}>

  <button style={btnAction} type="button" onClick={agregarLineaParte}>
    ➕ Añadir línea

  </button>
  <div style={{ fontSize: 12, color: "#6b7280" }}>
    Añade varias descripciones con sus horas y luego guarda todo.
  </div>
</div>

{/* === FIN BLOQUE NUEVO === */}

<div style={{
    gridColumn: "1 / -1",
    display: "flex",
    flexDirection: "column", // 🔹 uno debajo del otro
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    position: "sticky",      // 🔹 se mantienen visibles
    bottom: 10,              // 🔹 pegados al fondo si haces scroll
    background: "#f9fafb",   // fondo claro para distinguirlos
    padding: 12,
    borderRadius: 8,
    zIndex: 10,
  }}>

  {/* Guardar TODO el parte: se desactiva si no hay líneas */}
  <button
  style={btnActionPrimary}
  onClick={guardarParteTrabajo}
  disabled={savingParte || (!hayLineasEnAlguno && (!parteProducto || parteHoras <= 0))}
  title={hayLineasEnAlguno ? "Guardar parte del taller" : "Añade una línea o rellena la línea rápida"}
>
  {savingParte ? "Guardando…" : "💾 Guardar parte (todo)"}
</button>

<button
  style={btnAction}
  className="no-print"
  onClick={printParteTaller}  
  disabled={!hayLineasEnAlguno && (!parteProducto || parteHoras <= 0)}
  title="Imprime el parte del taller (todas las secciones)"
>
  🖨️ Imprimir parte del taller
</button>

  {/* Mensajes y ayudas (debajo, centrados) */}
{parteMsg && (
      <div style={{ fontSize: 13 }}>{parteMsg}</div>
    )}
    <div style={{ fontSize: 12, color: "#6b7280" }}>
      Añade varias descripciones con sus horas y luego guarda todo.
    </div>
    <div style={{ fontSize: 12, color: "#6b7280" }}>
       Se abrirá una ventana para imprimir o guardar en PDF. No se guarda en base de datos.
</div>

  {/* === LISTADO AGRUPADO POR TRABAJADOR === */}
<div style={{ marginTop: 10, border: "1px solid #e5e7eb", borderRadius: 8, padding: 10 }}>
  <div style={{ fontWeight: 600, marginBottom: 8 }}>Líneas por trabajador</div>

  {(() => {
    // Aseguramos que aparece el trabajador seleccionado, aunque no tenga líneas
    const trabajadoresConSeccion = new Set<string>(Object.keys(partePorTrabajador));
    trabajadoresConSeccion.add(parteTrabajador);

    // Lo pasamos a array y ordenamos por nombre visible
    const lista = Array.from(trabajadoresConSeccion).sort((a, b) => {
      const wa = workers.find(w => w.id === a)?.nombre || a;
      const wb = workers.find(w => w.id === b)?.nombre || b;
      return wa.localeCompare(wb, "es");
    });

    if (lista.length === 0) {
      return <div style={{ color: "#6b7280", fontSize: 13 }}>Aún no hay líneas.</div>;
    }
    
    return (
      <>
        {lista.map(wid => {
          const w = workers.find(x => x.id === wid);
          const nombre = w?.nombre || wid;
          const items = partePorTrabajador[wid] ?? [];
          const total = totalesPorTrabajador[wid] ?? 0;

          return (
            <div key={`sec-${wid}`} style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>
                👤 {nombre}
              </div>

              <div style={{
                display: "grid",
                gridTemplateColumns: "1fr 100px 1fr 90px",
                gap: 8, fontSize: 14, fontWeight: 600, color: "#374151"
              }}>
                <div>Descripción/bloque</div><div>Horas</div><div>Observaciones</div><div></div>
              </div>

              {items.length === 0 ? (
                <div style={{ padding: "8px 0", color: "#6b7280", fontSize: 13 }}>— Sin líneas aún —</div>
              ) : (
                items.map((it, idx) => (
                  <div key={`pi-${wid}-${idx}`} style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 100px 1fr 90px",
                    gap: 8, alignItems: "center",
                    padding: "6px 0", borderTop: "1px solid #f3f4f6"
                  }}>
                    <div>{it.producto}</div>
                    <div>{it.horas_reales}</div>
                    <div style={{ whiteSpace: "pre-wrap" }}>{it.observaciones || "—"}</div>
                    <button style={btnDanger} onClick={() => eliminarLineaParteDe(wid, idx)}>Eliminar</button>
                  </div>
                ))
              )}

              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8, fontWeight: 700 }}>
                Subtotal {nombre}: {total}
              </div>
            </div>
          );
        })}

        <div style={{
          marginTop: 12, paddingTop: 8, borderTop: "2px solid #e5e7eb",
          display: "flex", justifyContent: "flex-end", fontWeight: 800
        }}>
          TOTAL HORAS TALLER: {totalTaller}
        </div>
      </>
    );
  })()}
</div>

</div>
</div>
</div>
</div>
          )}  
          {/* FORM + TRABAJADORES */}
          <div style={panelRow} className="no-print">
            <div style={panel}>
              <div style={panelTitle}>Nuevo bloque</div>
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
                    {workers.map((w) => <option key={`wopt-${w.id}`} value={w.id}>{w.nombre}</option>)}
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
      <td style={td}>
        <input
          style={disabledIf(input, locked)}
          disabled={locked}
          type="number"
          min={0}
          step={0.5}
          value={w.extraDefault}
          onChange={(e) => editWorker(w.id, { extraDefault: Number(e.target.value) })}
        />
      </td>
      <td style={td}>
        <input
          disabled={locked}
          type="checkbox"
          checked={w.sabadoDefault}
          onChange={(e) => editWorker(w.id, { sabadoDefault: e.target.checked })}
        />
      </td>

      {/* NUEVO: columna de acciones */}
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
                {locked ? "Bloqueado: solo lectura." :
                <>Doble clic en una <b>celda</b> para fijar <b>extras/sábado</b> de ese <b>día</b>. Botón <b>＋</b> inserta un bloque desde ese día.</>}
              </div>
            </div>
          </div>

          {/* CABECERA DÍAS (impresión mensual) */}
          <div style={daysHeader} className={printMode === "monthly" ? "" : "no-print"}>
            {weekDaysHeader.map((d, i) => (
              <div key={`dow-${i}`} style={{ padding: "6px 8px", fontWeight: 600 }}>{d}</div>
            ))}
          </div>

          {/* CALENDARIO */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }} className={printMode === "monthly" ? "" : "no-print"}>
            {orderedWorkers.map((w) => (
              <div key={`worker-${w.id}`}>
                <div style={{ fontSize: 25, fontWeight: 700, margin: "8px 0 4px", color: "#111827" }}>👤 {w.nombre}</div>

                {weeks.map((week) => (
                  <div key={`${w.id}-wk-${week[0].toISOString()}`} style={weekRow}>
                    {week.map((d) => {
                      const f = fmt(d);
                      const delDia = f ? slices.filter((s) => s.trabajadorId === w.id && s.fecha === f) : [];
                      const cap = capacidadDia(w, d, overrides);
                      const used = usadasEnDia(slices, w.id, d);
                      const over = used > cap + 1e-9; // "over" significa "se pasó"
                      const ow = f ? overrides[w.id]?.[f] : undefined;

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
                          title={`Doble clic: extras/sábado para ${w.nombre} el ${f || "día"}`}
                          onDoubleClick={() => canEdit && editOverrideForDay(w, d)}
                          onDragOver={onDragOver}
                          onDrop={(e) => onDropDay(e, w.id, d)}
                        >
                          {/* Cabecera del día: número + avisos + botón ＋ */}
<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
  <div style={dayLabel}>
    {/* Solo el número del día */}
    {format(d, "d")}
    {" "}
    {/* Avisos en rojo: extras o sábado ON */}
    {ow ? (
      <span style={{ fontSize: 14, color: "#d81327", fontWeight: 700 }}>
       {getDay(d) !== 6 && ow.extra && Number(ow.extra) > 0 ? ("+" + ow.extra + " h extra") : ""}
       {getDay(d) === 6 && ow.sabado ? "Sábado ON" : ""}
      </span>
    ) : null}
  </div>

  {/* Botón + para insertar manual */}
  {canEdit && (
    <button
      className="no-print"
      onClick={() => addManualHere(w, d)}
      style={smallPlusBtn}
      title="Insertar manual aquí"
    >
      ＋
    </button>
  )}
</div>

                          <div style={horizontalLane}>
                            {delDia.map((s) => {
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
                                    <span style={productFull}>
                                      {isUrgent && (
                                        <svg
                                          xmlns="http://www.w3.org/2000/svg"
                                          width="14"
                                          height="14"
                                          viewBox="0 0 24 24"
                                          fill="#fff"
                                          stroke="#000"
                                          strokeWidth="2"
                                          style={{ marginRight: 6 }}
                                        >
                                          <path d="M10.29 3.86L1.82 18a1 1 0 00.86 1.5h18.64a1 1 0 00.86-1.5L13.71 3.86a1 1 0 00-1.72 0z" />
                                          <line x1="12" y1="9" x2="12" y2="13" />
                                          <line x1="12" y1="17" x2="12" y2="17" />
                                        </svg>
                                      )}
                                      {s.producto}
                                    </span>
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
                          <tr key={`pd-${s.id}`}>
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

          {/* Parte diario — todos (solo impresión) */}
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
                        <div key={`pdall-${w.id}`} className="worker-block">
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
                                <tr key={`pdall-row-${s.id}`}>
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
  background: "#e6f7fb",
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
const input: React.CSSProperties = { padding: "8px 10px", border: "1px solid #e5e7eb", borderRadius: 8, outline: "none", width: "100%", boxSizing: "border-box" };
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
