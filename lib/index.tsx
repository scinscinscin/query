import { createContext, useContext, useEffect, useState } from "react";

type EventTypeEnum = "refetch";

interface QueryProvider {
  debugPrint: (...parts: any) => void;
  fetch: <D>(key: string, cb: () => Promise<D>, opts?: { timeoutInSeconds?: number }, tries?: number) => Promise<D>;
  get: (key: string) => { insertedAt: number; data: unknown } | undefined;
  set: (key: string, data: unknown) => void;
  attachListener: (key: string, cb: (eventType: EventTypeEnum) => Promise<void>) => void;
  invalidateCache: (key: string) => void;
}

export const QueryContext = createContext<QueryProvider>(undefined as any);

export function generateQueryProvider(debug = false): QueryProvider {
  const map = new Map<string, { insertedAt: number; data: unknown }>();
  const listeners = new Map<string, ((e: EventTypeEnum) => Promise<void>)[]>();

  // @ts-ignore
  if (debug === true) globalThis["__query_cachemap"] = map;

  return {
    debugPrint(...parts: any) {
      if (debug) console.log(`@scinorandex/react=query:`, ...parts);
    },

    get(queryKey) {
      return map.get(queryKey);
    },

    set(queryKey, data) {
      this.debugPrint(`${queryKey} being set to`, data, "on", new Date());
      return map.set(queryKey, { data, insertedAt: Date.now() });
    },

    attachListener(queryKey, cb) {
      if (!listeners.has(queryKey)) listeners.set(queryKey, []);
      const listenerArray = listeners.get(queryKey);
      listenerArray!.push(cb);
    },

    invalidateCache(queryKey) {
      map.delete(queryKey);
      const listenerArray = listeners.get(queryKey);

      if (listenerArray) {
        const [primary, ...rest] = listenerArray;

        primary("refetch").then(() => {
          if (map.has(queryKey)) rest.forEach((cb) => cb("refetch"));
        });
      }
    },

    async fetch<D>(queryKey: string, fetchFn: () => Promise<D>, opts?: { timeoutInSeconds?: number }, tries = 0) {
      const cache = this.get(queryKey);

      if (cache == undefined || (Date.now() - cache.insertedAt) / 1000 > (opts?.timeoutInSeconds ?? 300)) {
        if (cache == undefined) this.debugPrint("no existing cache exists for item: " + queryKey);
        else this.debugPrint("cache time elapsed for item: " + queryKey);

        if (tries >= 3) throw new Error(`Was not able to fetch query-key: ${queryKey}. Not retrying`);

        try {
          const data = await fetchFn();
          this.set(queryKey, data);
          return data;
        } catch {
          return this.fetch(queryKey, fetchFn, opts, tries++);
        }
      } else {
        this.debugPrint("found cache for: ", queryKey, cache);
        return cache.data as D;
      }
    },
  };
}

interface UseQueryOptions<Data> {
  queryKey: string;
  queryFn: () => Promise<Data>;
  timeoutInSeconds?: number;
}

export function useQuery<Data>(opts: UseQueryOptions<Data>) {
  const queryProvider = useContext(QueryContext);
  const [data, setData] = useState<Data | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);

  const timeoutInSeconds = opts.timeoutInSeconds ?? 300;

  async function loadState() {
    try {
      const data = await queryProvider.fetch(opts.queryKey, opts.queryFn);
      setData(data);
    } catch {
      setIsError(true);
    }

    setIsLoading(false);
  }

  let timer: number | null = null;
  function reloadInSeconds(seconds: number) {
    queryProvider.debugPrint("setup debug for", opts.queryKey);
    if (timer === null) {
      timer = setTimeout(() => {
        loadState().then(() => {
          timer = null;
          reloadInSeconds(seconds);
        });
      }, seconds * 1000);
    }
  }

  function isDataLoaded() {
    return data !== null && isLoading === false && isError === false;
  }

  useEffect(() => {
    queryProvider.attachListener(opts.queryKey, async (e) => {
      switch (e) {
        case "refetch":
          await loadState();
          break;
      }
    });
  }, []);

  useEffect(() => {
    queryProvider.debugPrint("configuring initial refetch for", opts.queryKey);
    loadState().then(() => reloadInSeconds(timeoutInSeconds));

    return () => {
      queryProvider.debugPrint(`unlatching refresh for ${opts.queryKey}`);
      if (timer !== null) clearTimeout(timer);
    };
  }, [opts.queryKey]);

  return { data, isLoading, isError, isDataLoaded };
}

interface UseMutationOpts<P, R> {
  invalidationKey: string;
  mutationFn: (parameters: P) => Promise<R>;
}

export function useMutation<P, R>(opts: UseMutationOpts<P, R>) {
  const queryProvider = useContext(QueryContext);

  return {
    mutate: (parameters: P) => {
      return new Promise<R>((resolve) => {
        opts.mutationFn(parameters).then(async (response) => {
          queryProvider.debugPrint(`response from the server for key ${opts.invalidationKey} is`, response);
          queryProvider.invalidateCache(opts.invalidationKey);
          resolve(response);
        });
      });
    },
  };
}
