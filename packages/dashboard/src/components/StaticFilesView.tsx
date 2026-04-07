import { useCallback, useEffect, useRef, useState } from 'react';
import type { StaticFileEntry } from '../api/types';
import { staticFilesApi } from '../api/client';
import { ConfirmDialog } from './ConfirmDialog';

interface StaticFilesViewProps {
  projectId: string;
  /** Base URL template, e.g. "https://play-preprod.wynk.in" */
  baseUrl?: string;
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

export function StaticFilesView({ projectId, baseUrl }: StaticFilesViewProps) {
  const [files, setFiles] = useState<StaticFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Upload state
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPath, setUploadPath] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<StaticFileEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Expanded groups
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const { files: fetched } = await staticFilesApi.list(projectId);
      setFiles(fetched);
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
      setError(err instanceof Error ? err.message : 'Failed to load files');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setUploadFile(file);
    setUploadPath(file ? file.name : '');
    setUploadError(null);
    setUploadSuccess(false);
  };

  const handleUpload = async () => {
    if (!uploadFile || !uploadPath.trim()) return;
    try {
      setUploading(true);
      setUploadError(null);
      await staticFilesApi.upload(projectId, uploadPath.trim(), uploadFile);
      setUploadSuccess(true);
      setUploadFile(null);
      setUploadPath('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      await load();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
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
    <div className="flex flex-col h-full min-h-0 bg-white">
      {/* Header bar */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-gray-200 bg-[#FAFAFA] flex items-center justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <div className="text-xs text-gray-500">
            {files.length} {files.length === 1 ? 'file' : 'files'}
            {files.length > 0 && <> · {formatBytes(totalSize)}</>}
          </div>
          {baseUrl && files.length > 0 && (
            <div className="text-xs text-gray-400 truncate">
              Served at: <span className="font-mono">{baseUrl}/static_files/…</span>
            </div>
          )}
        </div>

        {/* Upload panel */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileSelect}
          />
          {!uploadFile ? (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-1.5 text-xs bg-gray-900 text-white rounded hover:bg-black"
            >
              Upload File
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-600 max-w-[120px] truncate">{uploadFile.name}</span>
              <input
                type="text"
                value={uploadPath}
                onChange={e => { setUploadPath(e.target.value); setUploadError(null); }}
                placeholder="Destination path…"
                className="border border-gray-300 rounded px-2 py-1 text-xs w-64 font-mono"
              />
              <button
                onClick={handleUpload}
                disabled={uploading || !uploadPath.trim()}
                className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {uploading ? 'Uploading…' : 'Confirm'}
              </button>
              <button
                onClick={() => { setUploadFile(null); setUploadPath(''); setUploadError(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                className="px-2 py-1.5 text-xs bg-white border border-gray-300 rounded hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Error / success banners */}
      {uploadError && (
        <div className="flex-shrink-0 px-4 py-2 bg-red-50 border-b border-red-200 text-xs text-red-700">
          {uploadError}
        </div>
      )}
      {uploadSuccess && !uploadFile && (
        <div className="flex-shrink-0 px-4 py-2 bg-green-50 border-b border-green-200 text-xs text-green-700">
          File uploaded successfully.
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
              Upload files one at a time, or run the importer with{' '}
              <span className="font-mono bg-gray-100 px-1 rounded">--static-files &lt;dir&gt;</span>
              {' '}to copy all at once.
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
                    baseUrl={baseUrl}
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
                      baseUrl={baseUrl}
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
  baseUrl?: string;
  onDelete: () => void;
  indent: number;
}

function FileRow({ file, baseUrl, onDelete, indent }: FileRowProps) {
  const [copied, setCopied] = useState(false);
  const filename = file.path.split('/').pop() ?? file.path;
  const url = baseUrl ? `${baseUrl}/static_files/${file.path}` : null;

  const copyUrl = () => {
    if (!url) return;
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
      {url && (
        <button
          onClick={copyUrl}
          title="Copy URL"
          className="opacity-0 group-hover:opacity-100 px-1.5 py-0.5 text-[10px] bg-gray-100 rounded text-gray-600 hover:bg-gray-200 flex-shrink-0"
        >
          {copied ? '✓' : 'Copy URL'}
        </button>
      )}
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
