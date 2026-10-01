/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_VERSION: string;
  readonly VITE_ENABLE_TELEMETRY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
