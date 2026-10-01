export interface AppUpdateInfo {
  version: string;
  downloadUrl: string;
  releaseNotes?: string;
  publishedAt?: string;
  forceUpdate?: boolean;
}

export interface UpdateProgress {
  percent: number;
  downloadedBytes: number;
  totalBytes: number;
}
