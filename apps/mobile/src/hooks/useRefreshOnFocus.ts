import { useCallback, useRef } from 'react'
import { useFocusEffect } from 'expo-router'

type RefreshableQuery = { dataUpdatedAt: number; refetch: () => unknown }

/**
 * Recarrega ao voltar para a aba só o que já passou de `staleMs`.
 *
 * As telas chamavam `refetch()` em todo foco, e `refetch()` ignora o
 * `staleTime`: alternar Início → Cobranças → Início refazia 15–20 requisições
 * com dados de segundos atrás. O primeiro foco é pulado porque a montagem já
 * busca. Voltar do segundo plano é coberto pelo `focusManager` (app/_layout).
 *
 * Lê `dataUpdatedAt` do último render: se estiver defasado, erra para o lado de
 * recarregar, nunca de mostrar dado velho.
 */
export function useRefreshOnFocus(queries: RefreshableQuery[], staleMs = 30_000) {
  const firstFocus = useRef(true)
  const latest = useRef(queries)
  latest.current = queries

  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false
        return
      }
      const now = Date.now()
      for (const q of latest.current) {
        if (now - q.dataUpdatedAt > staleMs) void q.refetch()
      }
    }, [staleMs]),
  )
}
