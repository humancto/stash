import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";
import { adder, type AddSource } from "./adder";

/** Adds, then shows the result: on a file page (maybe playing) it stays and
 * says so; anywhere else it goes to Transfers. */
export function useAddAndGo() {
  const navigate = useNavigate();
  const location = useLocation();
  const onWatch = location.pathname.startsWith("/watch/");
  return useCallback(
    async (source: AddSource): Promise<boolean> => {
      const ok = await adder.add(source);
      if (!ok) return false;
      if (onWatch) adder.setStatus("Added. It's on Transfers.");
      else void navigate("/transfers", { state: { added: true } });
      return true;
    },
    [navigate, onWatch],
  );
}
