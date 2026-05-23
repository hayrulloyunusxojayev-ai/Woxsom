import { useEffect, useRef, useState } from "react";
import { useListOrders, getListOrdersQueryKey } from "@workspace/api-client-react";

const STORAGE_KEY = "woxsom_last_seen_order_ts";

function getLastSeenTs(): number {
  try {
    return parseInt(localStorage.getItem(STORAGE_KEY) ?? "0", 10) || 0;
  } catch {
    return 0;
  }
}

function setLastSeenTs(ts: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(ts));
  } catch {
    // ignore
  }
}

export function useNewOrders() {
  const { data: orders } = useListOrders({
    query: {
      queryKey: getListOrdersQueryKey(),
      refetchInterval: 30_000,
      staleTime: 20_000,
    },
  });

  const [newCount, setNewCount] = useState(0);
  const prevCountRef = useRef<number>(0);

  useEffect(() => {
    if (!orders || orders.length === 0) return;

    const lastSeenTs = getLastSeenTs();

    const unseenOrders = orders.filter((o) => {
      const ts = new Date(o.createdAt).getTime();
      return ts > lastSeenTs;
    });

    const count = unseenOrders.length;

    if (count !== prevCountRef.current) {
      prevCountRef.current = count;
      setNewCount(count);
    }
  }, [orders]);

  const markAsSeen = () => {
    if (!orders || orders.length === 0) return;
    const latestTs = Math.max(
      ...orders.map((o) => new Date(o.createdAt).getTime())
    );
    setLastSeenTs(latestTs);
    prevCountRef.current = 0;
    setNewCount(0);
  };

  return { newCount, markAsSeen };
}
