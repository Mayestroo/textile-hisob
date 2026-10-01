export type ElectronRuntimeModeResult = {
  success: boolean;
  mode: 'legacy' | 'sync';
  error?: string;
  code?: string;
};

export async function resolveElectronRuntimeMode(
  eAPI: any,
  options: { productionBuild?: boolean } = {}
): Promise<ElectronRuntimeModeResult> {
  if (!eAPI || typeof eAPI.getRuntimeMode !== 'function') {
    const productionBuild = options.productionBuild ?? import.meta.env.PROD;
    if (productionBuild) {
      return {
        success: false,
        mode: 'sync',
        error: 'The production client requires its authenticated Electron runtime bridge',
        code: 'ELECTRON_RUNTIME_REQUIRED'
      };
    }
    return { success: true, mode: 'legacy' };
  }

  try {
    const result = await eAPI.getRuntimeMode();
    if (result?.mode === 'sync') {
      return {
        success: result.success === true,
        mode: 'sync',
        error: result.error,
        code: result.code
      };
    }
    if (result?.mode === 'legacy' && result.success === true) {
      return { success: true, mode: 'legacy' };
    }
    return {
      success: false,
      mode: 'sync',
      error: result?.error || 'Runtime mode could not be established',
      code: result?.code || '_RUNTIME_NOT_READY'
    };
  } catch (error) {
    return {
      success: false,
      mode: 'sync',
      error: error instanceof Error ? error.message : 'Runtime mode could not be established',
      code: '_RUNTIME_NOT_READY'
    };
  }
}

export function getElectronApi() {
  return typeof window === 'undefined' ? undefined : (window as any).electronAPI;
}
