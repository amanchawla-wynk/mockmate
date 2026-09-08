import { useCallback, useEffect, useRef, useState } from 'react';
import type { StaticFileEntry } from '../api/types';
import { staticFilesApi } from '../api/client';
import { ConfirmDialog } from './ConfirmDialog';

interface StaticFilesViewProps {
  projectId: string;
}

// Mirrors the server upload cap (MAX_STATIC_BYTES and the express.raw '50mb'
// limit in packages/server/src/routes/static-files.ts). Keep in sync.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_UPLOAD_LABEL = '50 MB';

// Extension → media type, matching the disk importer so streaming assets are
// served with the Content-Type players expect (e.g. HLS manifests/segments).
const MEDIA_TYPES: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  m3u8: 'application/vnd.apple.mpegurl',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ts: 'video/mp2t',
  m4s: 'video/iso.segment',
  vtt: 'text/vtt',
  json: 'application/json',
};

function inferMediaType(name: string, fallback: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return MEDIA_TYPES[ext] ?? fallback;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionIcon(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (['m3u8'].includes(ext)) return '📋';
  if (['ts'].includes(ext)) return '🎬';
  if (['mp4', 'mov', 'webm'].includes(ext)) return '🎥';
  if (['html', 'htm'].includes(ext)) return '🌐';
  return '📄';
}

/** Group files by their first directory segment for tree-style display. */
function groupFiles(files: StaticFileEntry[]): Map<string, StaticFileEntry[]> {
  const groups = new Map<string, StaticFileEntry[]>();
  for (const f of files) {
    const slashIdx = f.path.indexOf('/');
    const group = slashIdx === -1 ? '' : f.path.slice(0, slashIdx);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(f);
  }
  return groups;
}

interface PendingUpload {
  id: string;
  file: File;
  path: string;
  tooLarge: boolean;
  error?: string;
}

interface CollectedFile {
  file: File;
  path: string;
}

function nextId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizePath(raw: string): string {
  return raw.split('\\').join('/').replace(/^\/+/, '');
}

/** Recursively read a webkit filesystem entry (folder drops) into flat files. */
async function readEntry(entry: FileSystemEntry, prefix: string, out: CollectedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ file, path: `${prefix}${entry.name}` });
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      const acc: FileSystemEntry[] = [];
      const read = () => reader.readEntries(batch => {
        if (batch.length === 0) resolve(acc);
        else { acc.push(...batch); read(); }
      }, reject);
      read();
    });
    for (const child of entries) await readEntry(child, `${prefix}${entry.name}/`, out);
  }
}

/** Extract files (preserving relative paths) from a drop, supporting folders. */
async function collectDropped(transfer: DataTransfer): Promise<CollectedFile[]> {
  const items = Array.from(transfer.items ?? []);
  const entries = items
    .map(item => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry != null);
  if (entries.length > 0) {
    const out: CollectedFile[] = [];
    for (const entry of entries) await readEntry(entry, '', out);
    return out;
  }
  return Array.from(transfer.files).map(file => ({
    file,
    path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
  }));
}

function toPending(collected: CollectedFile[]): PendingUpload[] {
  return collected.map(({ file, path }) => ({
    id: nextId(),
    file,
    path: normalizePath(path),
    tooLarge: file.size > MAX_UPLOAD_BYTES,
  }));
}

export function StaticFilesView({ projectId }: StaticFilesViewProps) {
  const [files, setFiles] = useState<StaticFileEntry[]>([]);
  const [deliveryBaseUrl, setDeliveryBaseUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);

  // Upload state
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<StaticFileEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Expanded groups
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    const generation = ++requestGenerationRef.current;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    const ownsRequest = () => mountedRef.current && requestGenerationRef.current === generation;

    try {
      setLoading(true);
      setError(null);
      const { files: fetched, baseUrl } = await staticFilesApi.list(projectId, controller.signal);
      if (!ownsRequest()) return;
      setFiles(fetched);
      setDeliveryBaseUrl(baseUrl);
      // Auto-expand all groups on first load.
      setExpandedGroups(prev => {
        if (prev.size > 0) return prev;
        const groups = new Set<string>();
        for (const f of fetched) {
          const slashIdx = f.path.indexOf('/');
          if (slashIdx !== -1) groups.add(f.path.slice(0, slashIdx));
        }
        return groups;
      });
    } catch (err) {
      if (!ownsRequest()) return;
      setError(err instanceof Error ? err.message : 'Failed to load files');
    } finally {
      if (ownsRequest()) {
        requestControllerRef.current = null;
        setLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    queueMicrotask(() => {
      if (active) void load();
    });
    return () => {
      active = false;
      mountedRef.current = false;
      requestGenerationRef.current += 1;
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
    };
  }, [load]);

  const addFiles = useCallback((collected: CollectedFile[]) => {
    if (collected.length === 0) return;
    setUploadError(null);
    setUploadSuccess(null);
    setPending(prev => {
      const merged = new Map(prev.map(item => [item.path, item] as const));
      for (const item of toPending(collected)) merged.set(item.path, item);
      return [...merged.values()];
    });
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []).map(file => ({
      file,
      path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    }));
    addFiles(selected);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragging(false);
    try {
      addFiles(await collectDropped(e.dataTransfer));
    } catch {
      setUploadError('Could not read the dropped files.');
    }
  }, [addFiles]);

  const handleDragEnter = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types ?? []).includes('Files')) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDragging(true);
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (Array.from(e.dataTransfer.types ?? []).includes('Files')) e.preventDefault();
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  };

  const updatePendingPath = (id: string, path: string) => {
    setPending(prev => prev.map(item =>
      item.id === id ? { ...item, path: normalizePath(path), error: undefined } : item));
  };

  const removePending = (id: string) => {
    setPending(prev => prev.filter(item => item.id !== id));
  };

  const uploadableCount = pending.filter(item => !item.tooLarge && item.path.trim()).length;

  const handleUploadAll = async () => {
    const queue = pending.filter(item => !item.tooLarge && item.path.trim());
    if (queue.length === 0) return;
    setUploading(true);
    setUploadError(null);
    setUploadSuccess(null);
    setProgress({ done: 0, total: queue.length });
    const failures: PendingUpload[] = [];
    let done = 0;
    for (const item of queue) {
      try {
        await staticFilesApi.upload(
          projectId,
          item.path.trim(),
          item.file,
          inferMediaType(item.path, item.file.type || 'application/octet-stream'),
        );
      } catch (err) {
        failures.push({ ...item, error: err instanceof Error ? err.message : 'Upload failed' });
      } finally {
        done += 1;
        setProgress({ done, total: queue.length });
      }
    }
    // Keep only files that failed or were skipped (too large); clear succeeded.
    setPending(prev => prev.filter(item =>
      item.tooLarge || failures.some(failure => failure.id === item.id))
      .map(item => failures.find(failure => failure.id === item.id) ?? item));
    const succeeded = queue.length - failures.length;
    if (succeeded > 0) setUploadSuccess(`Uploaded ${succeeded} file${succeeded === 1 ? '' : 's'}.`);
    if (failures.length > 0) setUploadError(`${failures.length} file${failures.length === 1 ? '' : 's'} failed to upload.`);
    setUploading(false);
    setProgress(null);
    await load();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      setDeleting(true);
      await staticFilesApi.delete(projectId, deleteTarget.path);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  const toggleGroup = (group: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const grouped = groupFiles(files);
  const totalSize = files.reduce((s, f) => s + f.size, 0);

  return (
    <div
      className="relative flex flex-col h-full min-h-0 bg-white"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Header bar */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-gray-200 bg-[#FAFAFA] flex items-center justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <div className="text-xs text-gray-500">
            {files.length} {files.length === 1 ? 'file' : 'files'}
            {files.length > 0 && <> · {formatBytes(totalSize)}</>}
          </div>
          {files.length > 0 && (
            <div className="text-xs text-gray-400 truncate">
              Served at: <span className="font-mono">{deliveryBaseUrl}/static_files/...</span>
            </div>
          )}
        </div>

        {/* Upload control */}
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className="text-xs text-gray-400">
            Drag &amp; drop files or folders · max {MAX_UPLOAD_LABEL} per file
          </span>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1.5 text-xs bg-gray-900 text-white rounded hover:bg-black"
          >
            Upload Files
          </button>
        </div>
      </div>

      {/* Pending upload queue */}
      {pending.length > 0 && (
        <div className="flex-shrink-0 border-b border-gray-200 bg-gray-50">
          <div className="px-4 py-2 flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-gray-700">
              {pending.length} file{pending.length === 1 ? '' : 's'} ready
              {progress && <> · uploading {progress.done}/{progress.total}…</>}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={handleUploadAll}
                disabled={uploading || uploadableCount === 0}
                className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {uploading ? 'Uploading…' : `Upload ${uploadableCount} file${uploadableCount === 1 ? '' : 's'}`}
              </button>
              <button
                onClick={() => setPending([])}
                disabled={uploading}
                className="px-2 py-1.5 text-xs bg-white border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
              >
                Clear
              </button>
            </div>
          </div>
          <div className="max-h-40 overflow-auto px-4 pb-2 space-y-1">
            {pending.map(item => (
              <div key={item.id} className="flex items-center gap-2 text-xs">
                <span className="flex-shrink-0">{extensionIcon(item.path)}</span>
                <input
                  type="text"
                  value={item.path}
                  onChange={e => updatePendingPath(item.id, e.target.value)}
                  disabled={uploading}
                  className={`flex-1 border rounded px-2 py-1 font-mono ${
                    item.tooLarge ? 'border-red-300 bg-red-50 text-red-700' : 'border-gray-300'
                  }`}
                />
                <span className={`flex-shrink-0 ${item.tooLarge ? 'text-red-600 font-medium' : 'text-gray-400'}`}>
                  {formatBytes(item.file.size)}
                  {item.tooLarge && <> · over {MAX_UPLOAD_LABEL}</>}
                </span>
                {item.error && <span className="text-red-600 flex-shrink-0" title={item.error}>failed</span>}
                <button
                  onClick={() => removePending(item.id)}
                  disabled={uploading}
                  className="flex-shrink-0 text-gray-400 hover:text-red-600 px-1 disabled:opacity-50"
                  title="Remove"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Error / success banners */}
      {uploadError && (
        <div className="flex-shrink-0 px-4 py-2 bg-red-50 border-b border-red-200 text-xs text-red-700">
          {uploadError}
        </div>
      )}
      {uploadSuccess && (
        <div className="flex-shrink-0 px-4 py-2 bg-green-50 border-b border-green-200 text-xs text-green-700">
          {uploadSuccess}
        </div>
      )}
      {error && (
        <div className="flex-shrink-0 px-4 py-2 bg-red-50 border-b border-red-200 text-xs text-red-700">
          {error}
        </div>
      )}

      {/* File tree */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-6 text-xs text-gray-500">Loading…</div>
        ) : files.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm text-gray-500 mb-1">No static files yet.</p>
            <p className="text-xs text-gray-400">
              Drag &amp; drop files or folders here (max {MAX_UPLOAD_LABEL} per file), or run the
              importer with{' '}
              <span className="font-mono bg-gray-100 px-1 rounded">--static-files &lt;dir&gt;</span>
              {' '}to copy larger sets at once.
            </p>
          </div>
        ) : (
          <div className="py-2">
            {Array.from(grouped.entries()).map(([group, groupFiles]) => {
              if (group === '') {
                // Root-level files
                return groupFiles.map(f => (
                  <FileRow
                    key={f.path}
                    file={f}
                    deliveryBaseUrl={deliveryBaseUrl}
                    onDelete={() => setDeleteTarget(f)}
                    indent={0}
                  />
                ));
              }
              const isExpanded = expandedGroups.has(group);
              return (
                <div key={group}>
                  {/* Group header */}
                  <button
                    onClick={() => toggleGroup(group)}
                    className="w-full px-4 py-1.5 flex items-center gap-2 text-xs text-gray-700 hover:bg-gray-50 text-left"
                  >
                    <span className="text-gray-400">{isExpanded ? '▾' : '▸'}</span>
                    <span>📁</span>
                    <span className="font-medium">{group}/</span>
                    <span className="text-gray-400 ml-auto">{groupFiles.length} files</span>
                  </button>
                  {isExpanded && groupFiles.map(f => (
                    <FileRow
                      key={f.path}
                      file={f}
                      deliveryBaseUrl={deliveryBaseUrl}
                      onDelete={() => setDeleteTarget(f)}
                      indent={1}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-blue-50/80 border-2 border-dashed border-blue-400 pointer-events-none">
          <div className="text-center">
            <p className="text-sm font-medium text-blue-700">Drop files or folders to upload</p>
            <p className="text-xs text-blue-500 mt-1">Max {MAX_UPLOAD_LABEL} per file</p>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        isOpen={!!deleteTarget}
        title="Delete file"
        message={`Delete "${deleteTarget?.path}"? This cannot be undone.`}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        confirmLabel={deleting ? 'Deleting…' : 'Delete'}
        variant="danger"
      />
    </div>
  );
}

interface FileRowProps {
  file: StaticFileEntry;
  deliveryBaseUrl: string;
  onDelete: () => void;
  indent: number;
}

function FileRow({ file, deliveryBaseUrl, onDelete, indent }: FileRowProps) {
  const [copied, setCopied] = useState(false);
  const filename = file.path.split('/').pop() ?? file.path;
  const encodedPath = file.path.split('/').map(encodeURIComponent).join('/');
  const url = `${deliveryBaseUrl}/static_files/${encodedPath}`;

  const copyUrl = () => {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      className="px-4 py-1 flex items-center gap-2 text-xs hover:bg-gray-50 group"
      style={{ paddingLeft: `${16 + indent * 20}px` }}
    >
      <span>{extensionIcon(file.path)}</span>
      <span className="flex-1 font-mono text-gray-800 truncate" title={file.path}>{filename}</span>
      <span className="text-gray-400 flex-shrink-0">{formatBytes(file.size)}</span>
      <button
          onClick={copyUrl}
          title="Copy URL"
          className="opacity-0 group-hover:opacity-100 px-1.5 py-0.5 text-[10px] bg-gray-100 rounded text-gray-600 hover:bg-gray-200 flex-shrink-0"
        >
          {copied ? '✓' : 'Copy URL'}
        </button>
      <button
        onClick={onDelete}
        title="Delete"
        className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 flex-shrink-0 px-1"
      >
        ✕
      </button>
    </div>
  );
}
