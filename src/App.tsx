import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase"; // o "../lib/supabase" según tengas la ruta
import Planificador from "./Planificador";

export default function App() {
  return <Planificador />;
}
