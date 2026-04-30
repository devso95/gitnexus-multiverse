import { useEffect, useState } from 'react';
import { get } from '../api';

interface DirEntry {
  name: string;
  path: string;
  type: 'dir';
}

interface FolderExplorerProps {
  onSelect: (path: string) => void;
  onClose: () => void;
}

export default function FolderExplorer({ onSelect, onClose }: FolderExplorerProps) {
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [directories, setDirectories] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const loadPath = (path?: string) => {
    setLoading(true);
    setErr('');
    get(`/api/mv/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`)
      .then((res) => {
        setCurrentPath(res.currentPath);
        setParentPath(res.parentPath);
        setDirectories(res.directories || []);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => loadPath(), []);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
      <div className="border-border w-[500px] rounded-xl border bg-surface p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">Select Folder</h3>
          <button onClick={onClose} className="text-text2 hover:text-white">
            ✕
          </button>
        </div>

        <div className="bg-surface2 border-border mb-3 flex items-center gap-2 rounded-lg border px-3 py-1.5 font-mono text-xs text-accent">
          <span className="opacity-50">📂</span>
          <span className="truncate">{currentPath}</span>
        </div>

        {err && <div className="text-err mb-2 text-xs">{err}</div>}

        <div className="border-border bg-surface2 h-64 overflow-y-auto rounded-lg border">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            </div>
          ) : (
            <div className="flex flex-col">
              {parentPath !== null && (
                <button
                  onClick={() => loadPath(parentPath)}
                  className="border-border border-b px-4 py-2 text-left text-sm text-white hover:bg-accent/10"
                >
                  <span className="mr-2 opacity-50">⬆</span> .. (Parent Directory)
                </button>
              )}
              {directories.map((d) => (
                <button
                  key={d.path}
                  onClick={() => loadPath(d.path)}
                  className="border-border flex items-center border-b px-4 py-2 text-left text-sm text-white hover:bg-accent/10"
                >
                  <span className="mr-3 opacity-50">📁</span>
                  <span className="flex-1 truncate">{d.name}</span>
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(d.path);
                      onClose();
                    }}
                    className="rounded px-2 py-0.5 text-xs font-medium text-accent hover:bg-accent hover:text-white"
                  >
                    Select
                  </div>
                </button>
              ))}
              {directories.length === 0 && (
                <div className="text-text2 p-8 text-center text-sm italic">No folders found.</div>
              )}
            </div>
          )}
        </div>

        <div className="mt-4 flex gap-2">
          <button
            onClick={() => {
              onSelect(currentPath);
              onClose();
            }}
            className="flex-1 rounded-lg bg-accent py-2 text-sm font-medium text-white hover:bg-accent/90"
          >
            Select Current Folder
          </button>
          <button
            onClick={onClose}
            className="bg-surface2 border-border text-text hover:bg-surface3 flex-1 rounded-lg border py-2 text-sm"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
