import { create } from 'zustand'
import type { PythonEnvStatus } from '@/services/backend'

interface EnvironmentState {
  status: PythonEnvStatus | null
  checking: boolean
  error: string
  checkedAt: number | null
  configKey: string
  setChecking: (checking: boolean) => void
  setStatus: (status: PythonEnvStatus, configKey: string) => void
  setError: (error: string) => void
  resetEnvironment: () => void
}

export const useEnvironmentStore = create<EnvironmentState>((set) => ({
  status: null,
  checking: false,
  error: '',
  checkedAt: null,
  configKey: '',
  setChecking: (checking) => set({ checking }),
  setStatus: (status, configKey) =>
    set({
      status,
      configKey,
      checkedAt: Date.now(),
      error: '',
    }),
  setError: (error) => set({ error }),
  resetEnvironment: () =>
    set({
      status: null,
      checking: false,
      error: '',
      checkedAt: null,
      configKey: '',
    }),
}))
