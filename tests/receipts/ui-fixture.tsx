// Synthetic SDK transport for the rendered receipt test; production uses the host SDK.
import { useCallback, useEffect, useState } from "react";
const actor = new URLSearchParams(location.search).get("actor") ?? "owner";
export function useHostContext() { return { userId: actor }; }
export function usePluginData<T>() {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(() => {
    fetch("/data").then(async (response) => { if (!response.ok) throw new Error("fixture read failed"); setData(await response.json()); setError(null); })
      .catch(setError).finally(() => setLoading(false));
  }, []);
  useEffect(refresh, [refresh]);
  return { data, error, loading, refresh };
}
export function usePluginAction() {
  return async (payload: unknown) => {
    const response = await fetch("/action", { method: "POST", headers: { "content-type": "application/json", "x-fixture-actor": actor }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error("Owner action refused");
    return response.json();
  };
}
