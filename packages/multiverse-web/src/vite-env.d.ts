/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MULTIVERSE_API?: string;
  readonly VITE_GITNEXUS_API?: string;
  readonly VITE_DEBUG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
