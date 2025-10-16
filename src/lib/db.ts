import { supabase } from "./supabase";

export type DBWorker = { id: string; nombre: string; extra_default: number; sabado_default: boolean };
export type DBSlice = { id: string; task_id: string; producto: string; fecha: string; horas: number; trabajador_id: string; color: string };
export type DBOverride = { worker_id: string; fecha: string; extra: number; sabado: boolean };

export async function loadWorkers(): Promise<DBWorker[]> {
  const { data, error } = await supabase.from("workers").select("*");
  if (error) throw error;
  return data ?? [];
}
export async function upsertWorker(w: DBWorker) {
  const { error } = await supabase.from("workers").upsert(w);
  if (error) throw error;
}
export async function updateWorker(id: string, patch: Partial<DBWorker>) {
  const { error } = await supabase.from("workers").update(patch).eq("id", id);
  if (error) throw error;
}

export async function loadSlices(): Promise<DBSlice[]> {
  const { data, error } = await supabase.from("task_slices").select("*").order("fecha",{ascending:true});
  if (error) throw error;
  return data ?? [];
}
export async function insertSlices(s: DBSlice[]) {
  if (!s.length) return;
  const { error } = await supabase.from("task_slices").upsert(s);
  if (error) throw error;
}
export async function updateSlice(id: string, patch: Partial<DBSlice>) {
  const { error } = await supabase.from("task_slices").update(patch).eq("id", id);
  if (error) throw error;
}
export async function deleteSlice(id: string) {
  const { error } = await supabase.from("task_slices").delete().eq("id", id);
  if (error) throw error;
}

export async function loadOverrides(): Promise<DBOverride[]> {
  const { data, error } = await supabase.from("day_overrides").select("*");
  if (error) throw error;
  return data ?? [];
}
export async function upsertOverride(o: DBOverride) {
  const { error } = await supabase.from("day_overrides").upsert(o);
  if (error) throw error;
}
