import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";
import { adder, type AddSource } from "./adder";

/** Adds, then shows the result: on a file page (maybe playing) and on the
 * Library it stays and says so; anywhere else it goes to Transfers. */
export function useAddAndGo() {
  const navigate = useNavigate();
  const location = useLocation();
  const onWatch = location.pathname.startsWith("/watch/");
  // The Library shows new transfers itself (the Downloading shelf).
  const stay = onWatch || location.pathname === "/";
  return useCallback(
    async (source: AddSource): Promise<boolean> => {
      const ok = await adder.add(source);
      if (!ok) return false;
      if (stay)
        adder.setStatus(
          onWatch ? "Added. It's on Transfers." : "Added. It's on the Downloading shelf.",
        );
      else void navigate("/transfers", { state: { added: true } });
      return true;
    },
    [navigate, onWatch, stay],
  );
}
