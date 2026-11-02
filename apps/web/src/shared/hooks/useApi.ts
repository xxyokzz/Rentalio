"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface ApiState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  /** True hanya pada pemuatan pertama; dipakai untuk skeleton. */
  initialLoading: boolean;
  reload: () => void;
  setData: (next: T | null) => void;
}

/**
 * Loader data sederhana dengan state loading/error/retry. Data server tidak
 * disalin ke state global agar status booking/stok tidak kedaluwarsa
 * (Notion 09 — "gunakan state management seperlunya").
 */
export function useApi<T>(loader: (() => Promise<T>) | null, deps: unknown[] = []): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(Boolean(loader));
  const [initialLoading, setInitialLoading] = useState(Boolean(loader));
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);
  const loaderRef = useRef(loader);

  // Loader disimpan lewat effect (bukan saat render) supaya referensi inline di
  // pemanggil tidak memicu perubahan ref selama render.
  useEffect(() => {
    loaderRef.current = loader;
  }, [loader]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    const current = loaderRef.current;
    if (!current) {
      setData(null);
      setError(null);
      setLoading(false);
      setInitialLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await current();
      if (!mounted.current) return;
      setData(result);
    } catch (caught) {
      if (!mounted.current) return;
      setError(caught);
    } finally {
      if (!mounted.current) return;
      setLoading(false);
      setInitialLoading(false);
    }
  }, []);

  useEffect(() => {
    void run();
    // Deps dari pemanggil diteruskan apa adanya agar reload terjadi seperti
    // useEffect biasa; `run` stabil sehingga tidak perlu masuk daftar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, nonce, ...deps]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { data, error, loading, initialLoading, reload, setData };
}
